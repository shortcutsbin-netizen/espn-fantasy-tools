/**
 * What changed in this version, shown once per browser after an update.
 *
 * Its own module because two places need it: the dashboard that shows it, and
 * the diagnostics preview that renders the dialog for inspection. When the
 * preview kept its own copy the two drifted, and the preview went on showing a
 * release that had already been superseded. A direct import between them would
 * be circular, so the list lives here and both read it.
 *
 * Bumped in the same edit as BUILD_MARKER: a version number that moved without
 * the notes moving is how a reader is told about the last release twice. An
 * empty list is a valid state \u2014 the popup then says only that the site was
 * updated, which is the honest thing to say about a build whose changes nobody
 * outside the repo would notice.
 */
export const RELEASE_NOTE_ITEMS = [
  'New tool: Fortune Teller. Every way the rest of the regular season can go, '
  + 'mapped in full. Tap results to watch your playoff odds move, find the simplest '
  + 'path to a playoff spot, and see the brackets any path produces.',
  'The home page standings gain a Sim % column once Fortune Teller has run, and a '
  + 'line marking the playoff places.',
  'After the regular season, every team shows as clinched or eliminated rather '
  + 'than a percentage.',
  'The LLM Data Export now includes Fortune Teller\u2019s playoff odds beside '
  + 'ESPN\u2019s.',
  'Help panels now open at their first step.',
  'Various bug fixes.',
];
