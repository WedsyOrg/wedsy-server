const { sendWhatsAppText } = require('../utils/whatsapp');
const WAAgentMessageRepository = require('../repositories/WAAgentMessageRepository');
const WAConversationRepository = require('../repositories/WAConversationRepository');
const WAConversationService = require('./WAConversationService');
const KiaraCrmSyncService = require('./KiaraCrmSyncService');
const SettingsService = require('./SettingsService');
const { KIARA_DEFAULT_SYSTEM_PROMPT } = require('./kiaraDefaultPrompt');
const NotificationFailureLog = require('../models/NotificationFailureLog');
const QualifiedLead = require('../models/QualifiedLead');
const { google } = require('googleapis');
// MB6 Slice 11: every Anthropic call rides the shared in-process queue
// (serialized, exponential backoff on 429) — shared with the Instagram agent.
// The queue owns the ANTHROPIC_API_URL test seam now.
const { callAnthropic } = require('../utils/anthropicQueue');

// Kiara's persona now lives in Settings (kiara.systemPrompt, founder-gated,
// 60s cache) and defaults to the verbatim former hardcoded text — an empty
// settings collection is byte-identical behavior.
const getSystemPrompt = async () => {
  try {
    return await SettingsService.get('kiara.systemPrompt');
  } catch (error) {
    console.error('[WhatsAppAgent] settings prompt read failed, using default:', error.message);
    return KIARA_DEFAULT_SYSTEM_PROMPT;
  }
};

// CRASH FIX: response.data.content[0].text threw on empty content arrays and
// tool/thinking-first responses. Find the first text block; null means the
// caller treats it as a failure (existing retry → FailureLog path).
const firstTextBlock = (response) => {
  const content = response && response.data && Array.isArray(response.data.content)
    ? response.data.content
    : [];
  const block = content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  return block ? block.text : null;
};

const EXTRACTOR_SYSTEM_PROMPT = 'You are a data extractor. Based on the conversation, check if the qualification is complete — meaning the assistant has thanked the user and said the team will connect within 24 hours. Extract whatever details were collected. ' +
  'Also decide two routing signals. (1) "escalate": set true when the customer explicitly asks for a human, shows frustration or anger, pushes pricing/negotiation beyond rapport, or the conversation is stuck (3+ exchanges without progress) — and ALWAYS when qualified is true (use escalateReason "Qualified — ready for your call"). Give a short escalateReason whenever escalate is true. ' +
  '(2) "classification": classify the contact as one of "lead" (a genuine wedding/engagement customer), "vendor" (a vendor/photographer/supplier pitching their services), "birthday" (a birthday inquiry), "corporate" (a corporate-event inquiry), or "destination" (a confirmed destination wedding outside Bengaluru). ' +
  'Respond ONLY with valid JSON, no markdown, no explanation. Format: {"qualified": true/false, "escalate": true/false, "escalateReason": "", "classification": "lead", "data": {"name": "", "eventType": "", "city": "", "eventDate": "", "numberOfEvents": "", "venueStatus": "", "venueName": "", "servicesRequired": "", "budget": "", "weddingStyle": ""}}';

const sendToClaude = async (history) => {
  const MAX_RETRIES = 2;
  let attempt = 0;

  const systemPrompt = await getSystemPrompt();

  while (attempt <= MAX_RETRIES) {
    try {
      // MB6 Slice 11: through the shared in-process queue (429 backoff inside).
      const response = await callAnthropic({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: systemPrompt,
        messages: history
      });
      const text = firstTextBlock(response);
      if (text === null) throw new Error('Anthropic response had no text block');
      return text;
    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        await NotificationFailureLog.create({
          service: 'Anthropic',
          error: error.message,
          attempts: attempt,
          createdAt: new Date()
        });
        console.error(`[WhatsAppAgent] Claude API failed after ${attempt} attempts:`, error.message);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

const checkQualified = async (history) => {
  const MAX_RETRIES = 2;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      // MB6 Slice 11: through the shared in-process queue (429 backoff inside).
      const response = await callAnthropic({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system: EXTRACTOR_SYSTEM_PROMPT,
        messages: history
      });
      const text = firstTextBlock(response);
      if (text === null) throw new Error('Anthropic response had no text block');
      try {
        return JSON.parse(text);
      } catch {
        // JSON parse failure keeps the pre-Kiara fallback: not qualified, no routing.
        return { qualified: false };
      }
    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        await NotificationFailureLog.create({
          service: 'Anthropic',
          error: error.message,
          attempts: attempt,
          createdAt: new Date()
        });
        console.error(`[WhatsAppAgent] Qualification check failed after ${attempt} attempts:`, error.message);
        return { qualified: false };
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

const saveQualifiedLead = async (phone, data, conversation = null) => {
  const existing = await QualifiedLead.findOne({ phone });
  // HOOK 3: the Sheets append and the CRM sync are INDEPENDENT — either may
  // succeed alone; each has its own synced flag and is retried on the next
  // qualification pass until it lands.
  if (existing && existing.googleSheetSynced && existing.crmSynced) {
    console.log('[WhatsAppAgent] Lead already qualified and synced, skipping:', phone);
    return existing;
  }

  let leadDoc = existing;
  if (!leadDoc) {
    try {
      leadDoc = await QualifiedLead.create({
        phone,
        phoneNumber: phone,
        name: data.name || '',
        eventType: data.eventType || '',
        city: data.city || '',
        eventDate: data.eventDate || '',
        numberOfEvents: data.numberOfEvents || '',
        venueStatus: data.venueStatus || '',
        venueName: data.venueName || '',
        servicesRequired: data.servicesRequired || '',
        budget: data.budget || '',
        weddingStyle: data.weddingStyle || ''
      });
      console.log('[WhatsAppAgent] Lead saved to MongoDB:', phone);
    } catch (error) {
      await NotificationFailureLog.create({
        service: 'QualifiedLeadDB',
        phone,
        error: error.message,
        attempts: 1,
        createdAt: new Date()
      });
      console.error('[WhatsAppAgent] MongoDB save failed:', error.message);
      return null;
    }
  } else {
    console.log('[WhatsAppAgent] Lead exists but not fully synced, retrying:', phone);
  }

  const MAX_RETRIES = 2;

  // ── Google Sheets append (UNCHANGED, independent of the CRM sync) ──────────
  if (!leadDoc.googleSheetSynced) {
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        const auth = new google.auth.GoogleAuth({
          keyFile: process.env.GOOGLE_SHEETS_KEY_PATH,
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: 'Sheet1!A:N',
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[
              leadDoc.name || '',
              leadDoc.phoneNumber || '',
              leadDoc.phone,
              leadDoc.eventType || '',
              leadDoc.city || '',
              leadDoc.eventDate || '',
              leadDoc.numberOfEvents || '',
              leadDoc.venueStatus || '',
              leadDoc.venueName || '',
              leadDoc.servicesRequired || '',
              leadDoc.budget || '',
              leadDoc.weddingStyle || '',
              leadDoc.source || '',
              leadDoc.qualifiedAt ? leadDoc.qualifiedAt.toISOString() : new Date().toISOString()
            ]]
          }
        });
        leadDoc.googleSheetSynced = true;
        await leadDoc.save();
        console.log('[WhatsAppAgent] Lead appended to Google Sheet:', phone);
        break;
      } catch (error) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          await NotificationFailureLog.create({
            service: 'GoogleSheets',
            phone,
            error: error.message,
            attempts: attempt,
            createdAt: new Date()
          });
          console.error(`[WhatsAppAgent] Google Sheet append failed after ${attempt} attempts:`, error.message);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  // ── HOOK 3: CRM sync (crmSynced mirrors the googleSheetSynced retry idiom) ──
  // Maps the extracted answers onto the linked Enquiry (qualificationData +
  // additionalInfo.kiaraAnswers), creates the Event Store days (best-effort),
  // flips the lead's qualified flag, and records wa_qualified_by_kiara.
  if (!leadDoc.crmSynced) {
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        await KiaraCrmSyncService.syncQualifiedToCrm(phone, data, conversation);
        leadDoc.crmSynced = true;
        await leadDoc.save();
        console.log('[WhatsAppAgent] Lead synced to CRM:', phone);
        break;
      } catch (error) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          await NotificationFailureLog.create({
            service: 'KiaraCrmSync',
            phone,
            error: error.message,
            attempts: attempt,
            createdAt: new Date()
          });
          console.error(`[WhatsAppAgent] CRM sync failed after ${attempt} attempts:`, error.message);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  return leadDoc.googleSheetSynced && leadDoc.crmSynced ? true : null;
};

const receiveMessage = async (phone, message, meta = {}) => {
  try {
    await WAAgentMessageRepository.saveMessage(phone, 'user', message);

    // HOOK 1: conversation upsert (freshness/preview/unread) + CRM lead
    // linkage with the full intake semantics (normalized-phone dedup,
    // re-enquiry on terminal leads, round-robin auto-assign).
    let conversation = await WAConversationService.recordInbound(phone, message);
    conversation = await WAConversationService.ensureLeadLinked(conversation, {
      profileName: meta.profileName,
      firstMessage: message
    });

    // Human-owned or closed conversation: the message is stored for the team,
    // Kiara stays silent — zero Anthropic spend, no auto-reply.
    if (conversation.mode !== 'ai' || conversation.status === 'closed') return;

    const history = await WAAgentMessageRepository.getHistory(phone);
    const reply = await sendToClaude(history);
    if (!reply) return;
    await WAAgentMessageRepository.saveMessage(phone, 'assistant', reply);
    await WAConversationRepository.touchOutbound(conversation._id, reply.slice(0, 120));
    await sendWhatsAppText(phone, reply, process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID);
    const updatedHistory = await WAAgentMessageRepository.getHistory(phone);

    // MB6 Slice 11: skip the qualification-check call entirely while the
    // conversation has fewer than 3 user messages — nobody qualifies (or needs
    // routing) two messages in, and this halves early call volume.
    const userMessages = updatedHistory.filter((m) => m.role === 'user').length;
    if (userMessages < 3) return;

    const qualification = await checkQualified(updatedHistory);

    // HOOK 2: escalation + classification routing (vendor/birthday/corporate
    // close out, destination escalates, qualified always escalates).
    conversation = await KiaraCrmSyncService.applyExtraction(conversation, qualification);

    if (qualification && qualification.qualified) {
      await saveQualifiedLead(phone, qualification.data, conversation);
    }
  } catch (error) {
    console.error('[WhatsAppAgent] receiveMessage error:', error.message);
  }
};

// Non-text inbound (image/audio/video/sticker/…): stored as a placeholder so
// humans see it in the thread, conversation freshness/unread bumped, lead
// ensured — but NO Claude call and NO auto-reply.
const receiveMedia = async (phone, type, meta = {}) => {
  try {
    const placeholder = `[media: ${type || 'unknown'}]`;
    await WAAgentMessageRepository.saveMessage(phone, 'user', placeholder);
    const conversation = await WAConversationService.recordInbound(phone, placeholder);
    await WAConversationService.ensureLeadLinked(conversation, {
      profileName: meta.profileName,
      firstMessage: placeholder
    });
  } catch (error) {
    console.error('[WhatsAppAgent] receiveMedia error:', error.message);
  }
};

module.exports = { receiveMessage, receiveMedia };
