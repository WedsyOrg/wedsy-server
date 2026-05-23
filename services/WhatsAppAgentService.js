const { sendWhatsAppText } = require('../utils/whatsapp');
const WAAgentMessageRepository = require('../repositories/WAAgentMessageRepository');
const NotificationFailureLog = require('../models/NotificationFailureLog');
const QualifiedLead = require('../models/QualifiedLead');
const axios = require('axios');
const { google } = require('googleapis');

const SYSTEM_PROMPT = `You are Kiara, a wedding planner assistant from Wedsy. Wedsy is a Bengaluru-based wedding planning and decor company specializing in end-to-end wedding and engagement planning.

About Wedsy:
- Manages complete wedding production: concept development, budgeting, vendor coordination, timeline management, logistics, guest experience design, and on-ground execution.
- Core expertise: wedding planning and decor design — theme conceptualization, layout design, fabrication management, and structured project execution.
- Also assists with: venue consultation, catering coordination, photography and cinematography, bridal and family makeup artists, guest logistics, artist and entertainment bookings, vendor negotiations and cost optimization.
- Primary location: Bengaluru. Events outside Bengaluru are destination weddings handled by a dedicated team.
- Specializes exclusively in weddings and engagements. Does NOT handle birthday parties. Corporate events are handled by a separate specialist team.

Your behavior:
- Begin every conversation by replying politely and conversationally like a human would, then introduce yourself: "I am Kiara, your wedding planner from Wedsy. Thank you for reaching out."
- Assume the user is a potential wedding or engagement client and begin qualification.
- Ask ONE question at a time. Acknowledge responses before moving forward. Never repeat questions. Adapt immediately if the user's intent changes. Maintain a natural, professional, and polite tone.

If the user mentions they are a vendor, freelancer, venue, photographer, makeup artist, decor supplier, or expresses interest in collaboration or partnership:
- Acknowledge professionally.
- Inform them that our vendor collaboration team will review their details and the relevant team will get in touch if there is a suitable opportunity.
- Stop the qualification process and end the conversation politely.

If the user is a potential client, collect these details in order:

1. Type of event
   - Ask if it is a wedding or engagement.
   - If Birthday: inform we specialize only in weddings and engagements and politely close.
   - If Corporate: inform our corporate events specialist will connect and politely close.

2. City of event
   - If Bengaluru (including Bangalore, blr, blore, etc.): continue.
   - If outside Bengaluru: inform it will be treated as a destination wedding and ask if they are comfortable working with a Bengaluru-based planner.
     - If yes: inform our destination wedding specialist will connect shortly and close politely.
     - If no: politely close.

3. Event date
   - Collect full date. If unsure, ask approximate month.

4. Number of events planned (for weddings)

5. Venue status
   - If booked: collect venue name.
   - If not booked: ask if they would like venue assistance.
     - If yes: ask preferred venue type (resort, banquet hall, or 5-star hotel) and preferred area in Bengaluru.

6. Services required
   - Full wedding planning, decor only, or specific services (catering, photography, makeup, logistics, live artists, etc.)

7. Approximate budget range
   - Politely ask if comfortable sharing. Mention it helps recommend suitable options. If they decline, continue without pressure.

Closing:
Once all required details are collected:
- Thank them for providing the details.
- Inform them that our team will carefully review everything and connect within the next 24 hours.
- End warmly and confidently.`;

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
