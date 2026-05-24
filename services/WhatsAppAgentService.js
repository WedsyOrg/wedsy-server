const { sendWhatsAppText } = require('../utils/whatsapp');
const WAAgentMessageRepository = require('../repositories/WAAgentMessageRepository');
const NotificationFailureLog = require('../models/NotificationFailureLog');
const QualifiedLead = require('../models/QualifiedLead');
const axios = require('axios');
const { google } = require('googleapis');

const SYSTEM_PROMPT = `You are Kiara, a wedding planner at Wedsy in Bengaluru. You're texting a potential client on WhatsApp.

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

Your goal is to naturally collect these details through conversation — don't make it feel like a form:
- Type of event (wedding or engagement)
- City
- Date or approximate month
- How many functions they're planning (just ask naturally, like "how many functions are you planning?" — don't list examples unless they ask)
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
- Thank them warmly in 1-2 casual sentences
- Tell them the team will be in touch within 24 hours
- End the conversation naturally, like a human would

Remember: you're texting, not writing an email. Keep it short, keep it real.`;

const sendToClaude = async (history) => {
  const MAX_RETRIES = 2;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 500,
          system: SYSTEM_PROMPT,
          messages: history
        },
        {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data.content[0].text;
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
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 400,
          system: 'You are a data extractor. Based on the conversation, check if the qualification is complete — meaning the assistant has thanked the user and said the team will connect within 24 hours. Extract whatever details were collected. Respond ONLY with valid JSON, no markdown, no explanation. Format: {"qualified": true/false, "data": {"name": "", "eventType": "", "city": "", "eventDate": "", "numberOfEvents": "", "venueStatus": "", "venueName": "", "servicesRequired": "", "budget": ""}}',
          messages: history
        },
        {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          }
        }
      );
      const text = response.data.content[0].text;
      try {
        return JSON.parse(text);
      } catch {
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

const saveQualifiedLead = async (phone, data) => {
  const existing = await QualifiedLead.findOne({ phone });
  if (existing && existing.googleSheetSynced) {
    console.log('[WhatsAppAgent] Lead already qualified and synced, skipping:', phone);
    return existing;
  }

  let leadDoc = existing;
  if (!leadDoc) {
    try {
      leadDoc = await QualifiedLead.create({
        phone,
        name: data.name || '',
        eventType: data.eventType || '',
        city: data.city || '',
        eventDate: data.eventDate || '',
        numberOfEvents: data.numberOfEvents || '',
        venueStatus: data.venueStatus || '',
        venueName: data.venueName || '',
        servicesRequired: data.servicesRequired || '',
        budget: data.budget || ''
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
    console.log('[WhatsAppAgent] Lead exists but not synced, retrying Sheets:', phone);
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
        range: 'Sheet1!A:K',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            leadDoc.name || '',
            leadDoc.phone,
            leadDoc.eventType || '',
            leadDoc.city || '',
            leadDoc.eventDate || '',
            leadDoc.numberOfEvents || '',
            leadDoc.venueStatus || '',
            leadDoc.venueName || '',
            leadDoc.servicesRequired || '',
            leadDoc.budget || '',
            leadDoc.qualifiedAt ? leadDoc.qualifiedAt.toISOString() : new Date().toISOString()
          ]]
        }
      });
      leadDoc.googleSheetSynced = true;
      await leadDoc.save();
      console.log('[WhatsAppAgent] Lead appended to Google Sheet:', phone);
      return true;
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
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

const receiveMessage = async (phone, message) => {
  try {
    await WAAgentMessageRepository.saveMessage(phone, 'user', message);
    const history = await WAAgentMessageRepository.getHistory(phone);
    const reply = await sendToClaude(history);
    if (!reply) return;
    await WAAgentMessageRepository.saveMessage(phone, 'assistant', reply);
    await sendWhatsAppText(phone, reply, process.env.WHATSAPP_AGENT_PHONE_NUMBER_ID);
    const updatedHistory = await WAAgentMessageRepository.getHistory(phone);
    const qualification = await checkQualified(updatedHistory);
    if (qualification && qualification.qualified) {
      await saveQualifiedLead(phone, qualification.data);
    }
  } catch (error) {
    console.error('[WhatsAppAgent] receiveMessage error:', error.message);
  }
};

module.exports = { receiveMessage };
