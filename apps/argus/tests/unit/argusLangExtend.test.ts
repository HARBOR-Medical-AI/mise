/**
 * @jest-environment jsdom
 */
/**
 * @file The language a composition extends: the frame's words alone, and
 * ChRIS's installed beside them in the places the tables have always had them.
 */
import { describe, it, expect } from '@jest/globals';

describe('the ARGUS language', () => {
  it('is the frame alone until a composition extends it, and then reads as it always has', async () => {
    const lang = await import('../../src/console/argusLang.js');
    expect(lang.VERB_LINES.some((line) => line.startsWith('runs '))).toBe(false);
    expect(lang.VERB_LINES[1]).toContain('claim files ·');
    expect(lang.DRAWER_CHORDS.map((chord) => chord.key)).not.toContain('2');
    expect(lang.sentence_parse('dag layout ranked')).toBeNull();
    const { chrisLanguage } = await import('../../src/compositions/chris/lang.js');
    lang.language_extend(chrisLanguage(() => { throw new Error('not asked'); }));
    expect(lang.VERB_LINES).toEqual(LINES);
    expect(lang.DRAWER_CHORDS.map((chord) => chord.key).slice(0, 22)).toEqual(KEYS);
    expect(lang.sentence_parse('dag layout ranked')).toEqual({ subject: 'dag', target: null, words: ['layout', 'ranked'] });
    expect(lang.sentence_parse('pacs query PatientID:1')).toBeNull();
    expect(lang.sentence_parse('pacs sort date')).not.toBeNull();
  });
});

/** The verb table as it stood before the language was split (#985), with the door's switch (D14). */
const LINES: string[] = [
  "pane [@id|%n] split left|right|above|below · zoom · close · close all · bind unlinked|fs|viewer",
  "pane [@id|%n] claim files|runs|pacs · focus left|right|up|down|@id|last · flip · resize left|right|up|down [percent]",
  "view files|runs|pacs        (the gutter givens, workspace scope)",
  "runs enter <feedId> · sort <col> [asc|desc] · filter <text>|off",
  "node enter · immerse · back · clear (the indicated node)",
  "dag [@id] layout ranked|molecule · projection 2d|3d · scale time|size · hue status|compute · draw spheres|stars · pulse [on|off] · census [on|off] · gravity [on|off] · select <feed or job> · enter <job> · physics charge|link|collide|gravity on|off · physics reset · refresh",
  "file [@id] home|back|download|delete · follow · root · list|cards|preview · sort <col> [asc|desc] · filter <text>|off",
  "pacs sort <col> [asc|desc] · filter <text>|off   (the results listing; every other pacs verb is the session's)",
  "image [@id] [--force] <path> · layout single|mpr|3d|slab · slice <n> · series <n> · wl <lo> <hi> · wl preset <name> · colormap gray|hot|jet|cool · save · tags · load · stop · guard <bytes>|off · ghost <0..1>|off · state",
  "tags [@id] redact on|off · filter <text>|off   (the pane that follows an image pane's slice)",
  "header stats|dag|away|restore",
  "console open|close|toggle|zoom|height <px>",
  "back                        (contextual back — exactly Esc)",
  "desktop save|load|show|list|delete [name] · load <ChRIS file> · clear · share",
  "attach [--reveal]           (how to reach THIS session from a terminal or another browser)",
  'stratus oci [manage]        (through a porter: your cloud session, entered as READ; manage asks your password once, there or here)',
  'chris                       (through a porter: back to your ChRIS session)',
  "argus verbs                 (this table; the long form is docs/argus-lang.adoc)",
  "argus keys                  (the prefix chords: one key, one drawer verb)",
  "help pane|keys|verbs        (the KEYS pane on the stage; keys and verbs print the tables here; bare help is the session's)",
  "notes pane                  (what the installed releases changed, as a pane; bare notes prints it here)",
  "capacity pane [<family>]    (what the region has free for a family, as a pane; bare capacity prints it here)",
  "trek [--seed <n>]           (the bridge takes the screen: BSD trek played from its controls; --credits, --help and --version are the session's)"
];
/** The first chords as they stood. */
const KEYS: string[] = ["%", "\"", "h", "j", "k", "l", "H", "J", "K", "L", "m", "z", "x", "u", "f", "v", "1", "2", "3", "o", ";", "q"];
