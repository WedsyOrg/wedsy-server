const NotificationFailureLog = require('../models/NotificationFailureLog');

const sendWhatsApp = async (phone, templateName, parameters = [], buttonParameters = null) => {
  const MAX_RETRIES = 2;
  let attempt = 0;

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
        `https://graph.facebook.com/v19.0/${process.env.META_WA_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.META_WA_ACCESS_TOKEN}`,
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
        `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.META_WA_ACCESS_TOKEN}`,
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
