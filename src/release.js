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
  'The site now keeps running when it is flooded with requests. Signing in no longer depends on the activity log, '
  + 'and the log limits how much of the day\u2019s allowance it can use.',
  'Site Backend now steps down in stages as the day\u2019s allowance is used: panels built from the activity log '
  + 'rest first, and everything else, the Overview included, carries on. Everything returns at 00:00 UTC.',
  'The activity log no longer records visits to the sign-in page, or failed sign-ins with no team chosen, so bots '
  + 'and scanners cannot fill it.',
  'New in Site Configuration: Sign-in length. Whoever administers this site can choose how long a sign-in lasts, '
  + 'from one hour to infinite. Changing the League Password signs everyone out.',
  'Various bug fixes and performance improvements.',
];

/**
 * The tools new in this release (C8). Site Configuration marks each with a small New tag in its Tools and Home page
 * order panels, so whoever administers the site sees what arrived before setting its visibility or arranging its
 * tile. The home page's own tiles never carry the tag.
 *
 * Kept here, beside the release notes, because both are written for the same release at the same moment (a
 * production package's Step 0): the list is reviewed with the notes, and like them it is cleared or rewritten for the
 * next release. Keys are those in src/tools.js; a test holds every one to a registered tool.
 */
export const NEW_TOOLS = ['site-api'];
