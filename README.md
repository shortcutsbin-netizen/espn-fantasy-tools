# ESPN Fantasy Tools

A private, password-protected website for one ESPN fantasy football league.

It pulls your league's live and historical data from ESPN, keeps it cached on
Cloudflare's edge, and puts a set of tools behind a single password you share
with your league. Nobody without that password sees anything at all.

It runs entirely on Cloudflare's free tier. Setup is a fork, two storage
containers, and a short wizard on the site itself — there is no code to write
and nothing to configure in the Cloudflare dashboard beyond creating those two
containers.

---

## Before you start

You will need:

- **A GitHub account.** Free.
- **A Cloudflare account.** Free, but R2 storage asks for a card on file even on
  the free tier. This deployment stays far inside the free limits, and step 5
  sets up an alert so you would know immediately if that ever changed.
- **Your ESPN league open in a browser.** You will need your League ID, and if
  your league is private, two cookie values from a signed-in session.
- **A computer, not a phone**, for the cookie step. Mobile browsers cannot show
  cookies. Everything else works fine on a phone.

Budget about twenty minutes.

---

## Setup

### 1. Fork the repository

Sign in to GitHub, open the **espn-fantasy-tools** repository, click **Fork**,
and create the fork under your own account.

A fork is your own copy. You can change it freely, and you can pull in later
improvements to the original without losing your settings.

### 2. Enable Actions on your fork

In your fork, open the **Actions** tab and click the button confirming you
understand the workflows. Then, navigate to the "Sync with upstream" action
in the sidebar and click to enable it. This is what lets your fork stay in 
sync with the original later on. Nothing runs until you allow it.

The sync cannot update its own workflow file. If an update ever changes it, the
sync stops with an error until you open your fork's page on GitHub once and
click **Sync fork**, then **Update branch**.

### 3. Create your Cloudflare account

Go to Cloudflare and sign up. **Choose "Sign in with GitHub" and use the same
GitHub account you just forked with** — it turns connecting the two in step 9
into a single click instead of a permissions detour.

### 4. Turn on R2 storage

In the Cloudflare dashboard go to **Storage & databases → R2 Object Storage**,
add a card, and activate R2.

Your card will not be charged. R2's free tier covers far more storage and far
more traffic than one fantasy league can generate; the card is Cloudflare's
anti-abuse requirement, not a bill.

### 5. Set a spending alert

Still in Cloudflare, go to **Manage account → Billing → Billable Usage** and
click **Create Budget Alert**. Set it to alert you when spending exceeds **$1**.

This should never fire. If it ever does you will hear about it immediately and
can switch things off long before it matters. Two minutes now for a permanent
safety net.

### 6. Create the KV namespace

Go to **Storage & databases → Workers KV** and click **Create Instance**. Name
it:

```
espn-fantasy-tools-config
```

Then go back to the Workers KV list and **copy the ID** shown next to it — a
long string of letters and numbers. You need it in step 8.

This holds your settings: league ID, your two passwords (hashed, never stored
as text), and your ESPN cookies. It is small, and it is private to your account.

### 7. Create the R2 bucket

Go to **Storage & databases → R2 Object Storage** and click **Create bucket**.

- **Name:** `espn-fantasy-tools-data`
- **Location:** Automatic
- **Default Storage Class:** Standard

Create it. This holds the ESPN data the site caches.

### 8. Point the code at your storage

Back in GitHub, in **your fork**, open `wrangler.jsonc` and click the pencil
icon at the top right to edit it. Two values change:

| Find | Replace with | Roughly |
|---|---|---|
| the `"name"` value | whatever you want your site called | line 2 |
| `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` | the KV ID you copied in step 6 | line 16 |

The name you choose becomes your web address:
`https://<name>.<your-cloudflare-subdomain>.workers.dev`

Click **Commit changes** to save.

### 9. Deploy

In Cloudflare go to **Compute → Workers & Pages → Create application**, then:

1. Choose **Connect GitHub**.
2. Set authorization to **Only select repositories** and pick your fork.
3. Click **Install and Authorize**, then **Continue with GitHub**, and select
   your fork again.
4. On the settings page:
   - Set **Project name** to the same name you used in step 8.
   - **Clear the Build command field completely.** Leave it empty.
   - Check that **Deploy command** is exactly `npx wrangler deploy`.
5. Click **Deploy**.

The first build takes a couple of minutes.

### 10. Turn on your public address

Once the build finishes, open your project and go to **Domains**. Enable the
**Production URL**, disable the **Preview URL**, then copy the production
address and open it in a new tab.

Disabling the preview URL matters: it is a second address pointing at the same
site, and you only want one door.

### 11. Get your setup code and finish in the browser

The site opens asking for a one-time setup code. That code is printed in your
build log, and nowhere else.

In Cloudflare, go to your project → **Deployments**, scroll down to **Recent
builds**, and click the most recent entry. Scroll through the build log until
you find a box like this:

```
==========================================================
       ESPN FANTASY TOOLS - FIRST-TIME SETUP CODE
==========================================================
                   XXXX-XXXX-XXXX
      Enter this on the site to begin configuration.
  It is shown only here, only to you, and stops working
                 once setup completes.
==========================================================
```

Enter that code on the site. The wizard takes it from there: two passwords,
your ESPN league, which tools to switch on, and your league history.

The code stops working the moment setup completes, so nobody who finds your
address later can reconfigure your site.

---

## What the wizard asks for

**Two passwords.** The **League Password** is the one you share — anyone with it
can use the site. The **Admin Password** is yours alone and unlocks Site
Configuration. Write both down. Neither can be recovered, only replaced.

**Your League ID.** Open your league on ESPN and look in the address bar for
`leagueId=` followed by a number. That number, digits only.

**Your ESPN cookies**, if your league is private — most are. On a computer, sign
in at fantasy.espn.com, open developer tools with **F12**, go to the
**Application** tab (**Storage** in Firefox and Safari), open **Cookies →
https://fantasy.espn.com**, and find the rows named `espn_s2` and `SWID`.

Copy each value exactly, and do not tidy them up. `espn_s2` contains sequences
like `%2B` that must stay exactly as they are, and `SWID` must keep its curly
braces. The wizard tests both against ESPN before saving, so you will know
straight away if something did not paste cleanly.

**League history** is the last step. It walks through past
seasons pulling every game result. This may take a few minutes depending on how
many seasons your league has — please do not close or refresh the tab while it
runs. Once you start it, it runs to the end on its own: it paces itself, retries
around any hiccup, and skips past anything it cannot fetch rather than stopping.
You can skip it and run it later from Site Configuration.

---

## After setup

Everything is adjustable from **Site Configuration**, reachable from the
dashboard and gated by your Admin Password. Change either password, replace your
ESPN cookies if league data stops loading, switch tools on and off, and re-run
or resume the history pull.

Fortune Teller starts switched off. Switch it on in Site Configuration and it
builds its map of every way the regular season can go by itself, as soon as the
league is close enough to the end for that to be done in full, then moves on
each week as results come in.

Site Configuration never keeps you signed in as admin. The password is asked for
when the page opens and checked again on every single change, and closing the
tab ends admin access completely. That is deliberate.

---

## If something goes wrong

**The site says it cannot reach your league.** Your `espn_s2` cookie has most
likely expired — ESPN rotates them. Sign in to ESPN again, copy both values
fresh, and paste them into Site Configuration → ESPN cookies.

**You cannot find the setup code in the build log.** It is printed near the end,
after the dependency install. If the build failed, the code was never generated:
fix the build and redeploy.

**The build fails.** The usual cause is a leftover **Build command**. It must be
empty — the build runs automatically as part of the deploy.

**Team names show as "Loading league data".** The site is still fetching your
league's team list. Give it a refresh; if it persists, your ESPN cookies are the
thing to check.

**Team names or bye weeks show as blanks or zeroes.** Some dataset never got
fetched. Open Site Configuration and use **Refresh all league data** — it walks
every dataset once and fills whatever is missing.

**You want to tear it all down and start again.** Safe to do, and safe to reuse
the same names. Delete in this order: the **Worker** first, then the **R2
bucket**, then the **KV namespace**, then the fork. Rebuild from step 1.

Order matters for one reason: the Worker declares Durable Object migrations, and
those are tracked per Worker. Deleting the Worker first discards that state so a
fresh deploy replays the migrations cleanly. Deleting the storage while the
Worker still exists, then redeploying over it, asks the platform to create
Durable Object classes that already exist and the deploy fails.

Reusing the same names is fine. A recreated KV namespace and R2 bucket are new
and empty despite the familiar name, and `workers.dev` addresses are not
edge-cached, so there is no stale copy of the old site to clear. An empty-looking
site after a rebuild is simply a site that has not been set up yet.

**You lost the Admin Password.** There is no recovery, by design. Delete the KV
namespace, create a new one, update `wrangler.jsonc` with the new ID, and run
setup again. Your cached data in R2 is untouched.

---

## What it costs to run

Nothing, on a normal league. For scale: Cloudflare's free tier allows 100,000
Worker requests a day, and a ten-person league refreshing all Sunday does not
come close. Data is cached rather than re-fetched, so ESPN is called only when
something has actually gone stale.
