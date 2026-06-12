const NotificationFailureLog = require('../models/NotificationFailureLog');

// Test seam: e2e suites point this at a local mock so no test ever hits Meta.
// Unset (production) ⇒ the real Graph endpoint, unchanged.
const GRAPH_BASE_URL = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com/v19.0';

// agentPhoneNumberId (additive, optional): send the template from the Kiara
// agent number instead of the default business number. Default = unchanged.
const sendWhatsApp = async (phone, templateName, parameters = [], buttonParameters = null, agentPhoneNumberId = null) => {
  const MAX_RETRIES = 2;
  let attempt = 0;
  const phoneNumberId = agentPhoneNumberId || process.env.META_WA_PHONE_NUMBER_ID;
  const accessToken = agentPhoneNumberId
    ? process.env.META_WA_AGENT_ACCESS_TOKEN
    : process.env.META_WA_ACCESS_TOKEN;

  const components = [
    {
      type: 'body',
      parameters: parameters.map(p => ({ type: 'text', text: String(p) }))
    }
  ];

  if (buttonParameters) {
    components.push({
      type: 'button',
      sub_type: buttonParameters.sub_type || 'url',
      index: buttonParameters.index || 0,
      parameters: buttonParameters.parameters
    });
  }

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(
        `${GRAPH_BASE_URL}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
              name: templateName,
              language: { code: 'en' },
              components
            }
          })
        }
      );

      if (!response.ok) throw new Error(`WhatsApp API error: ${response.status}`);
      return await response.json();

    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        try {
          await NotificationFailureLog.create({
            service: 'WhatsApp',
            template: templateName,
            phone,
            error: error.message,
            attempts: attempt,
            createdAt: new Date()
          });
        } catch (logErr) {
          console.error('[WhatsApp] Failed to log failure:', logErr.message);
        }
        console.error(`[WhatsApp] Failed after ${attempt} attempts for template ${templateName}:`, error.message);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

const sendWhatsAppText = async (phone, message, agentPhoneNumberId = null) => {
  const MAX_RETRIES = 2;
  let attempt = 0;
  const phoneNumberId = agentPhoneNumberId || process.env.META_WA_PHONE_NUMBER_ID;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(
        `${GRAPH_BASE_URL}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${agentPhoneNumberId ? process.env.META_WA_AGENT_ACCESS_TOKEN : process.env.META_WA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { body: message }
          })
        }
      );

      if (!response.ok) throw new Error(`WhatsApp API error: ${response.status}`);
      return await response.json();

    } catch (error) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        try {
          await NotificationFailureLog.create({
            service: 'WhatsApp',
            phone,
            error: error.message,
            attempts: attempt,
            createdAt: new Date()
          });
        } catch (logErr) {
          console.error('[WhatsApp] Failed to log failure:', logErr.message);
        }
        console.error(`[WhatsApp] Failed after ${attempt} attempts for text message:`, error.message);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

module.exports = { sendWhatsApp, sendWhatsAppText };
