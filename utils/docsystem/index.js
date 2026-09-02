/**
 * utils/docsystem/index.js — the entry.
 *
 * buildVenueDocument resolves the venue's chosen design language (Settings →
 * documentLanguage; Classic when unset) and renders ONE of the five documents
 * through the one engine. The venue picks a language once and gets it on
 * every document — no document ever substitutes another language silently
 * (ruling 2: Stationery serves its own statement, as adapted in its recipes).
 */
const { Engine } = require("./engine");
const { LANGUAGES, LANGUAGE_NAMES } = require("./languages");
const { RENDERERS } = require("./documents");
const assemble = require("./assemble");

function resolveLanguage(venue) {
  const pick = venue && venue.settings && venue.settings.documentLanguage;
  return LANGUAGES[pick] || LANGUAGES.classic;
}

const ASSEMBLERS = {
  quote: assemble.assembleQuote,
  confirmation: assemble.assembleConfirmation,
  invoice: assemble.assembleInvoice,
  statement: assemble.assembleStatement,
  receipt: assemble.assembleReceipt,
};

/**
 * @param {string} type   quote | confirmation | invoice | statement | receipt
 * @param {object} inputs { venue, lead?, booking?, quote?, invoice?, summary?, paymentId?, logoBuffer? }
 * @param {object} [opts] { compress?: boolean, language?: string (test override) }
 * @returns {Promise<{buffer: Buffer, pages: number, data: object}|null>}
 */
async function buildVenueDocument(type, inputs, opts = {}) {
  const renderer = RENDERERS[type];
  const assembler = ASSEMBLERS[type];
  if (!renderer || !assembler) throw new Error(`unknown document type: ${type}`);
  const language = (opts.language && LANGUAGES[opts.language]) || resolveLanguage(inputs.venue);
  const data = assembler(inputs);
  if (!data) return null;
  const R = new Engine({ language, identity: data.identity, meta: data.meta, compress: opts.compress !== false });
  await renderer(R, data);
  const buffer = await R.finish();
  return { buffer, pages: R.pageIndex + 1, data };
}

module.exports = { buildVenueDocument, LANGUAGE_NAMES, resolveLanguage };
