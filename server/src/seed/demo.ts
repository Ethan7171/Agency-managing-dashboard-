// Demo seed — makes the dashboard fully explorable before any live key is
// connected. Five agencies across all three platforms with distinct quality
// profiles so the leaderboard tells an obvious story:
//   Leadbird (smartlead)    — strong keeper, ~3.5× ROI
//   Hyperke (instantly)     — solid keeper, ~2.3× ROI
//   Reachly (emailbison)    — watch: decent volume, weak conversion, ~1.4×
//   OneAway (instantly)     — watch/new: 5 weeks of data, trending up
//   Dream Giant (smartlead) — clear cut: high bounce, reply collapse, ~0.4×
// Also seeds: one unattributed Close win, one cross-agency lead collision,
// sample reply threads, monthly spend, and a webhook-style alert history.
// Connections are created with sync_status='demo' and no secret — the worker
// skips them, so demo mode and live mode can coexist.
import { pool, q } from "../db/pool.js";
import { migrate } from "../db/migrate.js";

const rand = (() => { let s = 42; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
const ri = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
const day = (offset: number) => {
  const d = new Date(); d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
};
const ts = (offset: number, hour = 10) => {
  const d = new Date(); d.setDate(d.getDate() - offset); d.setHours(hour, ri(0, 59), 0, 0);
  return d.toISOString();
};
const monthStart = (monthsAgo: number) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
};

interface Profile {
  name: string; code: string; platform: string; contact: string;
  days: number; dailySends: [number, number];
  bounce: number; reply: number; positiveShare: number; spamRate: number;
  meetingsPerWeek: [number, number]; showRate: number;
  closes: Array<{ name: string; mrr: number; weeksAgo: number }>;
  monthlyRetainer: number; slaDailySends: number;
  decay?: boolean; // Dream Giant: performance degrades over the window
}

const PROFILES: Profile[] = [
  {
    name: "Leadbird", code: "leadbird", platform: "smartlead", contact: "Nick A.",
    days: 90, dailySends: [900, 1400], bounce: 0.015, reply: 0.028, positiveShare: 0.38,
    spamRate: 0.0003, meetingsPerWeek: [3, 5], showRate: 0.78,
    closes: [
      { name: "Verdant Home Goods", mrr: 4500, weeksAgo: 9 },
      { name: "Kindred Pet Co", mrr: 3800, weeksAgo: 6 },
      { name: "Solstice Skincare", mrr: 6500, weeksAgo: 3 },
      { name: "Northwind Apparel", mrr: 5500, weeksAgo: 1 }
    ],
    monthlyRetainer: 5000, slaDailySends: 1000
  },
  {
    name: "Hyperke", code: "hyperke", platform: "instantly", contact: "Dara M.",
    days: 90, dailySends: [700, 1100], bounce: 0.02, reply: 0.024, positiveShare: 0.34,
    spamRate: 0.0005, meetingsPerWeek: [2, 4], showRate: 0.72,
    closes: [
      { name: "Copperline Coffee", mrr: 3600, weeksAgo: 4 },
      { name: "Atlas Audio", mrr: 6800, weeksAgo: 2 }
    ],
    monthlyRetainer: 3800, slaDailySends: 800
  },
  {
    name: "Reachly", code: "reachly", platform: "emailbison", contact: "Sam K.",
    days: 75, dailySends: [1100, 1700], bounce: 0.028, reply: 0.012, positiveShare: 0.22,
    spamRate: 0.0008, meetingsPerWeek: [1, 2], showRate: 0.6,
    closes: [{ name: "Brightside Bedding", mrr: 3200, weeksAgo: 4 }],
    monthlyRetainer: 2400, slaDailySends: 1200
  },
  {
    name: "OneAway", code: "oneaway", platform: "instantly", contact: "Priya R.",
    days: 35, dailySends: [300, 650], bounce: 0.018, reply: 0.026, positiveShare: 0.36,
    spamRate: 0.0004, meetingsPerWeek: [1, 3], showRate: 0.75,
    closes: [{ name: "Juniper & Fog Candles", mrr: 3900, weeksAgo: 1 }],
    monthlyRetainer: 3000, slaDailySends: 500
  },
  {
    name: "Dream Giant", code: "dreamgiant", platform: "smartlead", contact: "Shane M.",
    days: 90, dailySends: [800, 1300], bounce: 0.055, reply: 0.008, positiveShare: 0.15,
    spamRate: 0.0016, meetingsPerWeek: [0, 1], showRate: 0.5,
    closes: [{ name: "Peak Form Supplements", mrr: 1800, weeksAgo: 10 }],
    monthlyRetainer: 4500, slaDailySends: 1000, decay: true
  }
];

const BRANDS = [
  "Verdant Home Goods","Kindred Pet Co","Solstice Skincare","Northwind Apparel","Copperline Coffee",
  "Atlas Audio","Brightside Bedding","Juniper & Fog Candles","Peak Form Supplements","Marlowe & Main",
  "Cedar Creek Outfitters","Lumen Beauty Lab","Foxglove Kitchen","Harbor Lane Kids","True North Nutrition",
  "Willow + Wren","Golden Hour Eyewear","Emberline Grills","Cloudsoft Sleep","Paloma Swim"
];
const domainOf = (brand: string) => brand.toLowerCase().replace(/[^a-z0-9]+/g, "") + ".com";

async function seed(): Promise<void> {
  await migrate();
  const existing = await q<{ c: string }>(`select count(*) c from agencies`);
  if (Number(existing.rows[0].c) > 0) {
    console.log("Database already has agencies — refusing to double-seed. (Truncate manually to re-seed.)");
    return;
  }

  for (const p of PROFILES) {
    const a = (await q<{ id: string }>(
      `insert into agencies (name, agency_code, status, primary_contact, sla_daily_sends, start_date, notes)
       values ($1,$2,'active',$3,$4,$5,$6) returning id`,
      [p.name, p.code, p.contact, p.slaDailySends, day(p.days),
       `Demo agency seeded with a ${p.days}-day history.`])).rows[0];

    const conn = (await q<{ id: string }>(
      `insert into connections (agency_id, platform, sync_status, last_synced_at, instance_url)
       values ($1,$2,'demo',now(),$3) returning id`,
      [a.id, p.platform, p.platform === "emailbison" ? `https://send.${p.code}.com` : null])).rows[0];

    const campaigns: string[] = [];
    const campaignNames = [`${p.name} — DTC Fashion & Apparel`, `${p.name} — Beauty & Skincare`, `${p.name} — Home & Living`];
    for (let i = 0; i < campaignNames.length; i++) {
      const c = (await q<{ id: string }>(
        `insert into campaigns (agency_id, connection_id, platform_campaign_id, name, status)
         values ($1,$2,$3,$4,'active') returning id`,
        [a.id, conn.id, `${p.code}-camp-${i + 1}`, campaignNames[i]])).rows[0];
      campaigns.push(c.id);
    }

    // 90 days of metrics; weekends lighter; Dream Giant decays over time.
    for (let d = p.days; d >= 0; d--) {
      const date = day(d);
      const dow = new Date(date).getDay();
      const weekend = dow === 0 || dow === 6;
      const progress = 1 - d / p.days; // 0 = oldest, 1 = today
      const decayMult = p.decay ? Math.max(0.35, 1 - progress * 0.75) : 1;
      const growMult = p.days <= 40 ? 0.6 + progress * 0.6 : 1; // new agency ramps up
      for (const cid of campaigns) {
        const base = ri(p.dailySends[0], p.dailySends[1]) / campaigns.length;
        const sent = Math.round(base * (weekend ? 0.25 : 1) * growMult);
        if (sent < 5) continue;
        const bounceMult = p.decay ? 1 + progress * 1.6 : 1;
        const bounced = Math.round(sent * p.bounce * bounceMult * (0.7 + rand() * 0.6));
        const delivered = sent - bounced;
        const replies = Math.round(delivered * p.reply * decayMult * (0.6 + rand() * 0.8));
        const positive = Math.round(replies * p.positiveShare * (0.6 + rand() * 0.8));
        const opens = Math.round(delivered * (0.45 + rand() * 0.2));
        const spam = rand() < p.spamRate * sent ? ri(1, 2) : 0;
        await q(
          `insert into daily_metrics (agency_id, campaign_id, date, emails_sent, delivered, bounced,
             opens, replies, positive_replies, unsubscribes, spam_complaints)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [a.id, cid, date, sent, delivered, bounced, opens, replies, positive, ri(0, 3), spam]);
      }
      // deliverability snapshot every day
      const snapBounce = p.bounce * (p.decay ? 1 + progress * 1.6 : 1) * (0.8 + rand() * 0.4);
      await q(
        `insert into deliverability_snapshots (agency_id, date, bounce_rate, spam_rate, inbox_placement, domain_health)
         values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
        [a.id, date, snapBounce.toFixed(4), (p.spamRate * (0.5 + rand())).toFixed(5),
         (0.97 - snapBounce * 2).toFixed(3),
         JSON.stringify({ domains: [`out1.${p.code}mail.com`, `out2.${p.code}mail.com`].map(dm => ({
           domain: dm, health: snapBounce > 0.04 ? "degraded" : "good" })) })]);
    }

    // leads
    // Exclude the two brands reserved for specific stories: the unattributed win
    // and the deliberate two-agency collision.
    const leadBrands = BRANDS.filter(b => !["Marlowe & Main", "Cedar Creek Outfitters"].includes(b)).slice(0, 12);
    const leadIds: Array<{ id: string; brand: string; email: string }> = [];
    for (let i = 0; i < leadBrands.length; i++) {
      const brand = leadBrands[i];
      const email = `founder@${domainOf(brand)}`;
      const l = (await q<{ id: string }>(
        `insert into leads (agency_id, platform_lead_id, email, company, company_domain, status,
           interest_status, first_contacted_at, last_activity_at)
         values ($1,$2,$3,$4,$5,'contacted',$6,$7,$8) returning id`,
        [a.id, `${p.code}-lead-${i + 1}`, email, brand, domainOf(brand),
         i < 4 ? "positive" : i < 6 ? "neutral" : null, ts(ri(10, p.days)), ts(ri(0, 9))])).rows[0];
      leadIds.push({ id: l.id, brand, email });
    }

    // meetings across the window
    const weeks = Math.floor(p.days / 7);
    for (let w = 0; w < weeks; w++) {
      const count = ri(p.meetingsPerWeek[0], p.meetingsPerWeek[1]);
      for (let i = 0; i < count; i++) {
        const lead = leadIds[ri(0, leadIds.length - 1)];
        const r = rand();
        const outcome = r < p.showRate ? "showed" : r < p.showRate + 0.15 ? "no_show" : "booked";
        await q(
          `insert into meetings (agency_id, lead_id, booked_at, scheduled_for, outcome, lead_name)
           values ($1,$2,$3,$4,$5,$6)`,
          [a.id, lead.id, ts(w * 7 + ri(0, 6)), ts(Math.max(0, w * 7 - 2)), outcome, lead.brand]);
      }
    }

    // closed-won deals
    for (const c of p.closes) {
      await q(
        `insert into deals (agency_id, close_opportunity_id, deal_name, value, recurring_value_mrr, status, won_at)
         values ($1,$2,$3,$4,$5,'won',$6)`,
        [a.id, `demo-oppo-${p.code}-${c.name.replace(/\W/g, "").toLowerCase()}`,
         c.name, c.mrr * 12, c.mrr, ts(c.weeksAgo * 7)]);
    }
    // one open deal each
    await q(
      `insert into deals (agency_id, close_opportunity_id, deal_name, value, recurring_value_mrr, status)
       values ($1,$2,$3,$4,$5,'open')`,
      [a.id, `demo-open-${p.code}`, BRANDS[ri(10, 19)], 30000, 2500]);

    // monthly spend, current + 2 prior months
    for (let m = 0; m < 3; m++) {
      if (p.days < 40 && m > 1) continue;
      await q(
        `insert into spend (agency_id, period, retainer, per_meeting_fee, per_close_fee, total_spend, notes)
         values ($1,$2,$3,$4,0,$5,$6) on conflict do nothing`,
        [a.id, monthStart(m), p.monthlyRetainer, m === 0 ? ri(0, 400) : ri(200, 600),
         p.monthlyRetainer + (m === 0 ? 200 : 400), m === 0 ? "Current month, partial" : null]);
    }

    // reply threads
    const threadSamples: Array<[string, string, string]> = [
      ["positive", "Re: quick idea for {brand}", "This actually caught my eye — we've been unhappy with our current agency. Can you send over a couple of the case studies you mentioned? Happy to find 20 minutes next week."],
      ["positive", "Re: {brand} × Flax", "Interesting timing. Our CAC has crept up 30% since March. What does your team need from us to scope this?"],
      ["neutral", "Re: creative refresh for {brand}", "Not the right quarter for us — circle back after BFCM planning wraps."],
      ["negative", "Re: paid social for {brand}", "Please remove me from this list."]
    ];
    for (let i = 0; i < (p.code === "dreamgiant" ? 2 : 4); i++) {
      const [status, subjTpl, body] = threadSamples[i];
      const lead = leadIds[i];
      await q(
        `insert into threads_cache (agency_id, platform_thread_id, lead_email, lead_company, subject,
           snippet, interest_status, messages, last_message_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [a.id, `${p.code}-thread-${i + 1}`, lead.email, lead.brand,
         subjTpl.replace("{brand}", lead.brand), body.slice(0, 150), status,
         JSON.stringify([
           { from: `jean@${p.code}-sending.com`, direction: "outbound", at: ts(ri(4, 12)),
             body: `Hey — noticed ${lead.brand} scaling on Shopify. We help DTC brands in your bracket cut CAC with performance creative + media buying. Worth a quick look?` },
           { from: lead.email, direction: "inbound", at: ts(ri(0, 3)), body }
         ]), ts(ri(0, 3))]);
    }
  }

  // Unattributed Close win — the bucket the dashboard surfaces for manual attribution.
  await q(
    `insert into deals (agency_id, close_opportunity_id, deal_name, value, recurring_value_mrr, status, won_at)
     values (null, 'demo-oppo-unattributed', 'Marlowe & Main', 42000, 3500, 'won', $1)`, [ts(12)]);

  // Cross-agency collision: Cedar Creek Outfitters contacted by Leadbird AND Reachly.
  const pair = (await q<{ id: string; agency_code: string }>(
    `select id, agency_code from agencies where agency_code in ('leadbird','reachly')`)).rows;
  for (const ag of pair) {
    await q(
      `insert into leads (agency_id, platform_lead_id, email, company, company_domain, status, first_contacted_at)
       values ($1,$2,'ops@cedarcreekoutfitters.com','Cedar Creek Outfitters','cedarcreekoutfitters.com','contacted',$3)
       on conflict do nothing`,
      [ag.id, `${ag.agency_code}-collision-1`, ts(ri(1, 5))]);
  }

  // A few historical alerts so the Alert Center isn't empty.
  const dg = (await q<{ id: string }>(`select id from agencies where agency_code='dreamgiant'`)).rows[0];
  await q(
    `insert into alerts (agency_id, type, severity, message, fingerprint) values
     ($1,'bounce_rate','critical','Dream Giant: 7-day bounce rate 5.4% exceeds threshold 3.0%.','seed:bounce:dg'),
     ($1,'reply_collapse','warning','Dream Giant: reply rate collapsed to 0.31% vs their own 0.94% baseline.','seed:collapse:dg'),
     (null,'lead_collision','critical','Collision: Cedar Creek Outfitters is being emailed by Leadbird AND Reachly. Deconflict now.','collision:cedarcreekoutfitters.com')
     on conflict do nothing`, [dg.id]);

  console.log("Demo seed complete: 5 agencies, ~90 days of history, threads, deals, spend, alerts.");
}

seed()
  .then(() => pool.end())
  .catch(e => { console.error(e); process.exit(1); });
