const { sendInstagramDM, fetchInstagramProfile } = require('../utils/instagram');
const WAAgentMessageRepository = require('../repositories/WAAgentMessageRepository');
const NotificationFailureLog = require('../models/NotificationFailureLog');
const QualifiedLead = require('../models/QualifiedLead');
const axios = require('axios');
const { google } = require('googleapis');

// MB6 Slice 7 — the MB4 hook pattern ADAPTED to Instagram's reality: the
// thread is keyed by the IG-scoped user id (NOT a phone). The conversation
// record carries channel:'instagram'; CRM lead linkage happens only once a
// real phone number is captured by the extractor. Until then the conversation
// lives unlinked in the inbox.
const WAConversationService = require('./WAConversationService');
const KiaraCrmSyncService = require('./KiaraCrmSyncService');
const LeadIntakeService = require('./LeadIntakeService');
const LeadInternalEventService = require('./LeadInternalEventService');
const WAConversationRepository = require('../repositories/WAConversationRepository');
const Enquiry = require('../models/Enquiry');

// MB6 Slice 11: every Anthropic call rides the shared in-process queue
// (serialized, exponential backoff on 429) — shared with the WhatsApp agent.
// The queue owns the ANTHROPIC_API_URL test seam.
const { callAnthropic } = require('../utils/anthropicQueue');

// CRASH FIX (mirrors MB4's WhatsApp fix): response.data.content[0].text threw
// on empty content arrays and tool/thinking-first responses. Find the first
// text block; null means the caller treats it as a failure.
const firstTextBlock = (response) => {
  const content = response && response.data && Array.isArray(response.data.content)
    ? response.data.content
    : [];
  const block = content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  return block ? block.text : null;
};

const SYSTEM_PROMPT = `You are Kiara, a wedding planner at Wedsy in Bengaluru. You're chatting with a potential client on Instagram DM.

Your personality:
- You text like a real human — short, warm, casual but professional
- Max 1-2 sentences per reply. Never write paragraphs.
- Use natural language. Contractions, light punctuation, occasional emoji (not every message)
- You sound like a knowledgeable friend who happens to plan weddings — not a bot, not a formal agent
- If someone asks about anything wedding related (venues, decor, catering, budget, trends, mehendi artists, photographers etc.) — answer naturally and helpfully, then gently steer back to understanding their needs
- Never use bullet points, numbered lists, or formal language
- Never say things like "Certainly!", "Absolutely!", "Of course!" — too robotic
- If they say something funny or casual, match their energy

About Wedsy:
- Bengaluru-based wedding planning and decor company
- Full-service: planning, decor design, vendor coordination, catering, photography, makeup, logistics, entertainment
- Primary city is Bengaluru. Outside Bengaluru = destination wedding (handled by a specialist)
- Only weddings and engagements. No birthdays. Corporate events handled separately.

Your goal is to naturally collect these details through conversation:
- Type of event (wedding or engagement)
- City
- Date or approximate month
- For weddings: how many days/functions
- Wedding style/theme (South Indian, North Indian, fusion, destination etc. — help them if unsure)
- Venue (booked or need help finding one)
- Services needed (full planning, decor only, specific things)
- Budget (ask softly, totally fine if they skip it)

How to handle edge cases:
- Vendor/photographer/supplier reaching out → "Oh nice! I'll pass your details to our vendor team, they'll reach out if there's a good fit 😊" then end politely
- Birthday inquiry → "Ah we actually specialise only in weddings and engagements! But if you ever need a wedding planner, you know where to find us 😄"
- Corporate inquiry → "Corporate events aren't our space, but we have a team that handles that — I'll connect you!"
- Outside Bengaluru → "Oh that's a destination wedding for us! We have a specialist for those — are you okay working with a Bengaluru-based planner?"
- Destination confirmed → "Perfect, I'll have our destination wedding team reach out to you shortly 😊" then end

When you have all the details:
- Ask for their phone number so the team can reach out — keep it casual, like "What's the best number to reach you on?"
- Once they share it, thank them warmly in 1-2 casual sentences
- Tell them the team will be in touch within 24 hours
- End the conversation naturally

Important: never close the conversation without getting their phone number first. If they're hesitant, reassure them it's just so the team can call/WhatsApp them directly.`;

const sendToClaude = async (history) => {
  const MAX_RETRIES = 2;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await callAnthropic({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: history
      });
      const text = firstTextBlock(response);
      if (text !== null) return text;
      throw new Error('No text block in Anthropic response');
    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        await NotificationFailureLog.create({
          service: 'Anthropic',
          error: error.message,
          attempts: attempt,
          createdAt: new Date()
        });
        console.error(`[InstagramAgent] Claude API failed after ${attempt} attempts:`, error.message);
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
      const response = await callAnthropic({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        // MB6 Slice 7: the WA extractor's routing contract (escalate +
        // classification), keeping IG's phone-collection mission —
        // qualification still requires the phone number.
        system: 'You are a data extractor. Based on the conversation, check if the qualification is complete — meaning the user has provided their phone number AND the assistant has thanked them and said the team will connect within 24 hours. Extract whatever details were collected. ' +
          'Also decide two routing signals. (1) "escalate": set true when the customer explicitly asks for a human, shows frustration or anger, pushes pricing/negotiation beyond rapport, or the conversation is stuck (3+ exchanges without progress) — and ALWAYS when qualified is true (use escalateReason "Qualified — ready for your call"). Give a short escalateReason whenever escalate is true. ' +
          '(2) "classification": classify the contact as one of "lead" (a genuine wedding/engagement customer), "vendor" (a vendor/photographer/supplier pitching their services), "birthday" (a birthday inquiry), "corporate" (a corporate-event inquiry), or "destination" (a confirmed destination wedding outside Bengaluru). ' +
          'Respond ONLY with valid JSON, no markdown, no explanation. Format: {"qualified": true/false, "escalate": true/false, "escalateReason": "", "classification": "lead", "data": {"name": "", "phoneNumber": "", "eventType": "", "city": "", "eventDate": "", "numberOfEvents": "", "venueStatus": "", "venueName": "", "servicesRequired": "", "budget": "", "weddingStyle": ""}}',
        messages: history
      });
      const text = firstTextBlock(response);
      if (text === null) return { qualified: false };
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        // RC1d: a parse failure silently dropped data.phoneNumber → no lead.
        // Surface it (the extractor JSON is malformed) without changing the
        // safe fallback behavior (not qualified, no routing).
        console.error('[InstagramAgent] extractor JSON parse failed:', parseErr.message);
        await NotificationFailureLog.create({
          service: 'IgExtractorParse',
          error: parseErr.message,
          attempts: 1,
          createdAt: new Date(),
        }).catch(() => {});
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
        console.error(`[InstagramAgent] Qualification check failed after ${attempt} attempts:`, error.message);
        return { qualified: false };
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

// ── IG lead creation — gated on WEDDING INTENT, not phone presence ───────────
// An IG conversation becomes a lead when Kiara's extractor classifies it a
// genuine wedding customer (classification === 'lead' — the EXISTING intent
// reasoning; no change to what Kiara says). A phone is desirable but NOT
// required: with a phone we use it (phone dedup); without one we still create
// the lead off the IG profile name + sender id, flagged "awaiting number" so the
// team nurtures toward it in the DM. No wedding intent → no lead (no junk).

const igPlaceholderPhone = (igSenderId) => `ig:${igSenderId}`;
const isPlaceholderPhone = (phone) => String(phone || '').startsWith('ig:');
const toFullPhone = (digits) => (digits.length === 10 ? `91${digits}` : digits);

// Existing lead for this IG person (no-number dedup key — the stable IG id).
const findExistingByIgSenderId = async (igSenderId) =>
  igSenderId ? Enquiry.findOne({ 'additionalInfo.instagramId': String(igSenderId) }) : null;

// Upgrade-in-place: a no-number IG lead finally shares a phone. Run phone-dedup
// across the CRM first — if the number already belongs to ANOTHER lead (e.g. a
// WhatsApp lead for the same person), consolidate onto that lead (link the
// conversation, mark this one merged) rather than duplicating; otherwise set the
// phone on this lead and clear the awaiting-number flag.
const upgradeLeadWithPhone = async (conversation, leadId, cleanPhone) => {
  const full = toFullPhone(cleanPhone);
  const byPhone = await LeadIntakeService.findExistingByNormalizedPhone(cleanPhone);
  if (byPhone && String(byPhone._id) !== String(leadId)) {
    await LeadIntakeService.recordReEnquiry(byPhone._id, {
      source: 'instagram', message: `Instagram DM (${conversation.phone})`,
    });
    await Enquiry.updateOne(
      { _id: byPhone._id, 'additionalInfo.instagramId': { $ne: String(conversation.phone) } },
      { $set: { 'additionalInfo.instagramId': String(conversation.phone) } }
    );
    await Enquiry.updateOne({ _id: leadId }, {
      $set: { 'additionalInfo.mergedIntoLeadId': String(byPhone._id), 'additionalInfo.awaitingNumber': false },
    });
    await WAConversationRepository.updateFieldsById(conversation._id, { enquiryId: byPhone._id });
    await LeadInternalEventService.record({
      leadId: byPhone._id, type: 'ig_lead_merged', actorId: null,
      payload: { fromLeadId: String(leadId), instagramId: String(conversation.phone), phone: full },
    });
    return byPhone._id;
  }
  try {
    await Enquiry.updateOne({ _id: leadId }, {
      $set: { phone: full, 'additionalInfo.awaitingNumber': false },
    });
  } catch (e) {
    // Unique-phone race: the number was just taken by another lead → merge onto it.
    const winner = await LeadIntakeService.findExistingByNormalizedPhone(cleanPhone);
    if (winner && String(winner._id) !== String(leadId)) {
      await Enquiry.updateOne({ _id: leadId }, { $set: { 'additionalInfo.mergedIntoLeadId': String(winner._id), 'additionalInfo.awaitingNumber': false } });
      await WAConversationRepository.updateFieldsById(conversation._id, { enquiryId: winner._id });
      return winner._id;
    }
    throw e;
  }
  await LeadInternalEventService.record({
    leadId, type: 'ig_number_captured', actorId: null,
    payload: { instagramId: String(conversation.phone), phone: full },
  });
  return leadId;
};

// Create or link the IG lead for a wedding-intent conversation. Dedup order:
// (1) by phone (shared with the rest of the CRM), (2) by IG sender id (the
// no-number case). Idempotent — an already-linked conversation only upgrades
// with a phone when one arrives.
const ensureIgLead = async (conversation, { phoneNumber, name } = {}) => {
  try {
    if (!conversation) return conversation;
    const igSenderId = String(conversation.phone);
    const cleanPhone = String(phoneNumber || '').replace(/\D/g, '');
    const hasPhone = cleanPhone.length >= 10;
    // No-number leads are named from the IG profile (the reliable identity we
    // have); phone leads prefer the extractor-captured contact name.
    const fallbackName = `Instagram ${igSenderId.slice(-4)}`;
    const displayName = hasPhone
      ? ((name || '').trim() || (conversation.profileName || '').trim() || fallbackName)
      : ((conversation.profileName || '').trim() || (name || '').trim() || fallbackName);

    // Already linked → the only remaining action is upgrading with a phone.
    if (conversation.enquiryId) {
      if (hasPhone) {
        const lead = await Enquiry.findById(conversation.enquiryId, { phone: 1 }).lean();
        if (lead && isPlaceholderPhone(lead.phone)) {
          await upgradeLeadWithPhone(conversation, conversation.enquiryId, cleanPhone);
        }
      }
      return conversation;
    }

    let enquiryId = null;

    // Dedup 1 — by phone (existing CRM lead, e.g. they're also a WhatsApp lead).
    if (hasPhone) {
      const byPhone = await LeadIntakeService.findExistingByNormalizedPhone(cleanPhone);
      if (byPhone) {
        enquiryId = byPhone._id;
        await LeadIntakeService.recordReEnquiry(byPhone._id, { source: 'instagram', message: `Instagram DM (${igSenderId})` });
        await Enquiry.updateOne({ _id: byPhone._id, 'additionalInfo.instagramId': { $ne: igSenderId } }, { $set: { 'additionalInfo.instagramId': igSenderId } });
      }
    }

    // Dedup 2 — by IG sender id (the same IG person; the no-number key).
    if (!enquiryId) {
      const byIg = await findExistingByIgSenderId(igSenderId);
      if (byIg) {
        enquiryId = byIg._id;
        await LeadIntakeService.recordReEnquiry(byIg._id, { source: 'instagram', message: `Instagram DM (${igSenderId})` });
        if (hasPhone && isPlaceholderPhone(byIg.phone)) {
          await upgradeLeadWithPhone({ ...conversation, enquiryId: byIg._id }, byIg._id, cleanPhone);
        }
      }
    }

    // Create — wedding intent, brand-new contact. Phone if we have it, else a
    // stable IG placeholder + awaitingNumber flag. createLead pins stage:new +
    // round-robin assignment, so the team picks it up like any other new lead.
    if (!enquiryId) {
      try {
        const created = await LeadIntakeService.createLead({
          name: displayName,
          phone: hasPhone ? toFullPhone(cleanPhone) : igPlaceholderPhone(igSenderId),
          verified: false,
          source: 'instagram',
          additionalInfo: { instagramId: igSenderId, ...(hasPhone ? {} : { awaitingNumber: true }) },
        });
        enquiryId = created._id;
      } catch (e) {
        // Race (duplicate webhook delivery) → fall back to whichever now exists.
        const winner = (hasPhone && await LeadIntakeService.findExistingByNormalizedPhone(cleanPhone)) || await findExistingByIgSenderId(igSenderId);
        if (!winner) throw e;
        enquiryId = winner._id;
      }
    }

    const updated = await WAConversationRepository.updateFieldsById(conversation._id, { enquiryId });
    await LeadInternalEventService.record({
      leadId: enquiryId,
      type: 'ig_conversation_linked',
      actorId: null,
      payload: { instagramId: igSenderId, phoneNumber: hasPhone ? cleanPhone : '', awaitingNumber: !hasPhone },
    });
    return updated;
  } catch (e) {
    // Surface the previously-swallowed failure (the "NO LEAD YET" symptom had
    // no trail).
    console.error('[InstagramAgent] ensureIgLead failed:', e.message);
    try {
      await NotificationFailureLog.create({
        service: 'IgLeadLink',
        phone: conversation && conversation.phone,
        error: e.message,
        attempts: 1,
        createdAt: new Date(),
      });
    } catch (logErr) {
      console.error('[InstagramAgent] failed to log IgLeadLink failure:', logErr.message);
    }
    return conversation;
  }
};

// Deterministic phone scan of the raw user messages — a phone is DESIRABLE but
// not the gate (wedding intent is). When present it lets us create/upgrade the
// lead with the real number instead of waiting on the AI extractor's parse.
const phoneFromHistory = (history) => {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== 'user') continue;
    const match = String(m.content || '').match(/(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)/);
    if (match) return match[1];
  }
  return '';
};

const saveQualifiedLead = async (instagramId, data, conversation = null) => {
  const existing = await QualifiedLead.findOne({ phone: instagramId });
  if (existing && existing.googleSheetSynced && existing.crmSynced) {
    console.log('[InstagramAgent] Lead already qualified and synced, skipping:', instagramId);
    return existing;
  }

  let leadDoc = existing;
  if (!leadDoc) {
    try {
      leadDoc = await QualifiedLead.create({
        phone: instagramId,
        phoneNumber: data.phoneNumber || '',
        name: data.name || '',
        eventType: data.eventType || '',
        city: data.city || '',
        eventDate: data.eventDate || '',
        numberOfEvents: data.numberOfEvents || '',
        venueStatus: data.venueStatus || '',
        venueName: data.venueName || '',
        servicesRequired: data.servicesRequired || '',
        budget: data.budget || '',
        weddingStyle: data.weddingStyle || '',
        source: 'Instagram DM'
      });
      console.log('[InstagramAgent] Lead saved to MongoDB:', instagramId);
    } catch (error) {
      await NotificationFailureLog.create({
        service: 'QualifiedLeadDB',
        phone: instagramId,
        error: error.message,
        attempts: 1,
        createdAt: new Date()
      });
      console.error('[InstagramAgent] MongoDB save failed:', error.message);
      return null;
    }
  } else {
    console.log('[InstagramAgent] Lead exists but not synced, retrying Sheets:', instagramId);
  }

  const MAX_RETRIES = 2;
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
      console.log('[InstagramAgent] Lead appended to Google Sheet:', instagramId);
      break;
    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        await NotificationFailureLog.create({
          service: 'GoogleSheets',
          phone: instagramId,
          error: error.message,
          attempts: attempt,
          createdAt: new Date()
        });
        console.error(`[InstagramAgent] Google Sheet append failed after ${attempt} attempts:`, error.message);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // HOOK 3 (MB6 Slice 7): CRM sync — crmSynced mirrors the googleSheetSynced
  // retry idiom, exactly like the WhatsApp agent. Requires a linked lead
  // (i.e. a captured phone), which the caller establishes first.
  if (!leadDoc.crmSynced && conversation && conversation.enquiryId) {
    attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        await KiaraCrmSyncService.syncQualifiedToCrm(data.phoneNumber || instagramId, data, conversation);
        leadDoc.crmSynced = true;
        await leadDoc.save();
        console.log('[InstagramAgent] Lead synced to CRM:', instagramId);
        break;
      } catch (error) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          await NotificationFailureLog.create({
            service: 'KiaraCrmSync',
            phone: instagramId,
            error: error.message,
            attempts: attempt,
            createdAt: new Date()
          });
          console.error(`[InstagramAgent] CRM sync failed after ${attempt} attempts:`, error.message);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  return leadDoc.googleSheetSynced && leadDoc.crmSynced ? true : null;
};

const receiveMessage = async (instagramId, message) => {
  try {
    await WAAgentMessageRepository.saveMessage(instagramId, 'user', message);

    // HOOK 1 (adapted): conversation upsert keyed by the IG user id,
    // channel:'instagram'. NO lead linkage yet — that waits for a real phone.
    let conversation = await WAConversationService.recordInbound(instagramId, message, 'instagram');

    // Instagram name (RC3): the message webhook carries no name, so fetch the
    // profile once via Graph and store it. Fire-safe — a missing name never
    // blocks the conversation.
    if (!conversation.profileName) {
      const profileName = await fetchInstagramProfile(instagramId);
      if (profileName) {
        conversation = await WAConversationRepository.updateFieldsById(conversation._id, { profileName });
      }
    }

    // Mode gate: a human owns the thread (takeover) or it's closed — the IG
    // bot stays silent, identically to WhatsApp. Zero Anthropic spend.
    if (conversation.mode !== 'ai' || conversation.status === 'closed') return;

    const history = await WAAgentMessageRepository.getHistory(instagramId);
    const reply = await sendToClaude(history);
    if (!reply) return;
    await WAAgentMessageRepository.saveMessage(instagramId, 'assistant', reply);
    await WAConversationRepository.touchOutbound(conversation._id, reply.slice(0, 120));
    await sendInstagramDM(instagramId, reply);
    const updatedHistory = await WAAgentMessageRepository.getHistory(instagramId);

    // MB6 Slice 11: same early-skip as WhatsApp — no qualification check
    // until the customer has sent at least 3 messages.
    const userMessages = updatedHistory.filter((m) => m.role === 'user').length;
    if (userMessages < 3) return;

    const qualification = await checkQualified(updatedHistory);

    // GATE: wedding intent (Kiara's existing classification), NOT phone presence.
    // classification === 'lead' means a genuine wedding/engagement customer — so
    // we create the lead with or without a number. A phone is captured if the
    // extractor returned one or it's visible in the raw messages (desirable, not
    // required). No wedding intent → no lead (keeps random DMs out of the CRM).
    const weddingIntent = !!(qualification && qualification.classification === 'lead');
    if (weddingIntent) {
      const capturedPhone =
        (qualification.data && qualification.data.phoneNumber) ||
        phoneFromHistory(updatedHistory);
      conversation = await ensureIgLead(conversation, {
        phoneNumber: capturedPhone,
        name: (qualification.data && qualification.data.name) || '',
      });
    }

    // HOOK 2 (adapted): escalation + classification routing — the same
    // contract as WhatsApp (vendor/birthday/corporate close out, destination
    // escalates, qualified always escalates). Channel-aware journey events.
    conversation = await KiaraCrmSyncService.applyExtraction(conversation, qualification);

    if (qualification && qualification.qualified) {
      await saveQualifiedLead(instagramId, qualification.data, conversation);
    }
  } catch (error) {
    console.error('[InstagramAgent] receiveMessage error:', error.message);
  }
};

module.exports = { receiveMessage };
