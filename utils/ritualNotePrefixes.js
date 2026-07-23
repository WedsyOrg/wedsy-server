// RITUAL NOTE PREFIXES — the "Notes & tasks" strip on every journey ritual
// interior (FE NotesTasksStrip) posts one-line notes to the internal-chat
// endpoint prefixed with the ritual's item name: "[Kickoff] …", "[Meetings] …",
// "[Lead comms] …", "[Proposal] …", "[Agreement] …", "[Onboard] …". These are
// NOTES misrouted into the chat store, not team messages. They are:
//   · surfaced in the merged note stream, prefix stripped (NoteStreamService)
//   · hidden from the chat rail read AND the unread count (LeadChatService)
// ONE source of truth for the set so both services agree. The match is ANCHORED
// at the start of the body ("^\\[Label\\] "), so a mid-body "[Proposal]" mention
// stays an ordinary chat message.
const RITUAL_NOTE_PREFIXES = [
  "Kickoff",
  "Meetings",
  "Lead comms",
  "Proposal",
  "Agreement",
  "Onboard",
];

// Escape regex metacharacters (labels are plain today, but stay safe if one is
// added with a metachar).
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Anchored alternation: ^\[(Kickoff|Meetings|Lead comms|Proposal|Agreement|Onboard)\]
const RITUAL_NOTE_PREFIX_RE =
  "^\\[(" + RITUAL_NOTE_PREFIXES.map(escapeRe).join("|") + ")\\] ";
const ritualNotePrefixRegExp = new RegExp(RITUAL_NOTE_PREFIX_RE);

// True when a chat body opens with a ritual prefix (a misrouted note).
const isRitualNote = (body) => ritualNotePrefixRegExp.test(String(body || ""));

// Strip the leading "[Label] " and trim. Non-matching bodies come back trimmed
// unchanged (callers gate on isRitualNote / the query regex first).
const stripRitualNotePrefix = (body) =>
  String(body || "").replace(ritualNotePrefixRegExp, "").trim();

module.exports = {
  RITUAL_NOTE_PREFIXES,
  RITUAL_NOTE_PREFIX_RE,
  ritualNotePrefixRegExp,
  isRitualNote,
  stripRitualNotePrefix,
};
