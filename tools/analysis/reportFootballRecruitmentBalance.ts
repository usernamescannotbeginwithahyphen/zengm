import fs from "node:fs/promises";
import { gunzipSync } from "node:zlib";

type Prospect = {
	pos: string;
	score: Record<string, number>;
	fit: Record<string, number>;
};
type Decision = {
	seed: number;
	season: number;
	team: string;
	pick: number;
	chosen: Prospect;
	chosenRole: { rank: number };
	alternatives: Prospect[];
};
type Audit = {
	aggregate: {
		positions: Record<string, number>;
		supplyTop32Ability: Record<string, number>;
		[key: string]: number | Record<string, number>;
	};
	safety: Record<string, number>;
	decisions: Decision[];
};
type Evidence = {
	checkpoints: {
		label: string;
		season: number;
		teams: { rosterCounts: Record<string, number> }[];
	}[];
};
const read = async <T>(path: string): Promise<T> =>
	JSON.parse(gunzipSync(await fs.readFile(path)).toString());
const before = await read<Audit>(
	"analysis/starter-score/league-recruitment-after-audit.json.gz",
);
const after = await read<Audit>(
	"analysis/starter-score/league-recruitment-balanced-audit.json.gz",
);
const holdout = await read<Audit>(
	"analysis/starter-score/league-recruitment-holdout-audit.json.gz",
);
const diagnosis = await read<{
	results: { name: string; expected: Record<string, number> }[];
}>("analysis/starter-score/league-draft-bias-diagnosis.json.gz");
const seeds = [20261005, 20261006, 20261007, 20261008];
const reference: Record<string, number> = {
	QB: 9.1,
	RB: 7,
	WR: 12,
	TE: 3.5,
	OL: 17.2,
	DL: 26.1,
	LB: 6.6,
	CB: 11.9,
	S: 6.6,
};
const starters: Record<string, number> = {
	QB: 1,
	RB: 1,
	WR: 3,
	TE: 1,
	OL: 5,
	DL: 4,
	LB: 2,
	CB: 3,
	S: 2,
	K: 1,
	P: 1,
};
const pos = Object.keys(starters);
const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(1)}%`;
const esc = (v: unknown) =>
	String(v ?? "—")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll('"', "&quot;");
const table = (headers: string[], rows: unknown[][]) =>
	`<div class="table"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const roster = async (prefix: string) => {
	const reports = await Promise.all(
		seeds.map((seed) =>
			read<Evidence>(`analysis/starter-score/${prefix}-${seed}.json.gz`),
		),
	);
	const teams = reports.flatMap((r) =>
		r.checkpoints
			.filter(
				(c) =>
					(c.label === "opening" && c.season > 2026) ||
					c.label === "final-opening",
			)
			.flatMap((c) => c.teams),
	);
	return Object.fromEntries(
		pos.map((p) => [
			p,
			{
				mean: teams.reduce((n, t) => n + t.rosterCounts[p]!, 0) / teams.length,
				short: teams.filter((t) => t.rosterCounts[p]! < starters[p]!).length,
			},
		]),
	);
};
const rosterBefore = await roster("league-recruitment-final");
const rosterAfter = await roster("league-recruitment-balanced");
const perSeed = (audit: Audit, seed: number, p: string) =>
	audit.decisions.filter((d) => d.seed === seed && d.chosen.pos === p).length;
const totalDistance = (audit: Audit) =>
	Object.entries(reference).reduce(
		(n, [p, ref]) =>
			n +
			Math.abs(
				(100 * audit.aggregate.positions[p]!) /
					(audit.aggregate.picks as number) -
					ref,
			),
		0,
	);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recruitment balance: position value and competition</title><style>body{margin:0;background:#f2f5f9;color:#182a40;font:16px/1.55 system-ui}main{max-width:1140px;padding:32px 24px 70px;margin:auto}h1{font-size:2.3rem;line-height:1.15}h2{margin-top:38px}p{max-width:95ch}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}td,th{padding:10px;border-bottom:1px solid #c6d0dd;text-align:left}th{background:#e2eaf4}a{color:#125caa}.note{padding:18px;background:white;border-left:4px solid #366ea6}li{margin:8px 0}</style></head><body><main>
<h1>Recruitment balance: position value and competition</h1>
<p>Four generated leagues, three seasons each, plus the following opening week. Each version covers 384 first-round picks and all drafted QBs' opening games. “Previous” is revision 782e299a3; “Revised” changes positional weights and draft opportunity for close challengers. These are real game simulations using generated players, not imported NFL rosters.</p>
<p class="note"><strong>Assessment:</strong> keep this revision. WR and DL selections increase, and OL and CB selections decrease, in every comparison league. Receiver recruitment also holds up in two fresh-seed leagues. Position balance remains incomplete: OL and CB are still high, DL and RB low, and rookie QB opening starts remain very common. This is evidence of improvement, not a claim of finished NFL calibration.</p>
<h2>First-round distribution</h2>${table(
	[
		"Role",
		"Previous picks",
		"Revised picks",
		"Previous %",
		"Revised %",
		"Supplied reference %",
		"Previous / revised top-32 ability supply",
	],
	pos.map((p) => [
		p,
		before.aggregate.positions[p],
		after.aggregate.positions[p],
		pct(before.aggregate.positions[p]!, before.aggregate.picks as number),
		pct(after.aggregate.positions[p]!, after.aggregate.picks as number),
		reference[p] ?? "—",
		`${before.aggregate.supplyTop32Ability[p]} / ${after.aggregate.supplyTop32Ability[p]}`,
	]),
)}
<p>The sum of absolute percentage-point gaps across the nine reference categories changes from ${totalDistance(before).toFixed(1)} to ${totalDistance(after).toFixed(1)}. This is descriptive, not a statistical significance test or optimization objective. The supplied image is an approximate, unverified reference. OL combines OT and IOL; DL groups EDGE and DT imperfectly. The simulator uses different roles, prospect generation and player development.</p>
<h2>Separate league results</h2>${table(
	[
		"Seed",
		"WR previous → revised",
		"OL previous → revised",
		"DL previous → revised",
		"CB previous → revised",
	],
	seeds.map((seed) => [
		seed,
		...["WR", "OL", "DL", "CB"].map(
			(p) => `${perSeed(before, seed, p)} → ${perSeed(after, seed, p)}`,
		),
	]),
)}
<p>Each row includes 96 picks. The starting seeds match, but acquisitions alter later random draws, so later prospect pools and outcomes diverge. The top-32 ability columns help expose that supply variation; they are not an objective best-player list.</p>
<h2>Two fresh seeds</h2><p>After choosing the revision, seeds 20261009 and 20261010 ran three seasons each with no further tuning. These six additional drafts are a check on the revised behavior; they have no old-formula counterpart.</p>${table(
	[
		"Role",
		"Fresh-seed picks",
		"Fresh-seed %",
		"All six revised leagues %",
		"Reference %",
	],
	pos.map((p) => [
		p,
		holdout.aggregate.positions[p],
		pct(holdout.aggregate.positions[p]!, holdout.aggregate.picks as number),
		pct(after.aggregate.positions[p]! + holdout.aggregate.positions[p]!, 576),
		reference[p] ?? "—",
	]),
)}
<p>Fresh-seed QB openers: ${holdout.aggregate.actualRookieOpenerStarts}/${holdout.aggregate.observedRookieOpeners} first-rounders started; ${holdout.aggregate.healthyRookiesBenchedInOpener} were healthy but benched. Healthy QB switches: ${holdout.safety.healthyQBChanges}; immediate healthy reversals: ${holdout.safety.immediateHealthyReversals}. MVP retention: ${holdout.safety.mvpsStillStarting}/${holdout.safety.mvps}. <a href="league-recruitment-holdout-audit.html">Inspect fresh-seed picks and alternatives</a>.</p>
<p>Supply matters to the remaining gaps. In the comparison leagues, CB accounts for 72/384 (18.8%) top-32 ability slots and 68/384 (17.7%) selections, versus the supplied 11.9% reference. Lowering CB value until picks reach the reference could suppress legitimately strong prospects. Conversely, RB has 31 top-32 ability slots but only 10 picks, so its opportunity and incumbent strength deserve a separate investigation. The fresh-seed classes contain only five top-32-ability LBs and three TEs; their low selection counts should not be attributed to recruitment weights alone.</p>
<h2>What caused the bias?</h2>
<p>Before changing the game, the diagnostic reevaluated all 384 saved prospect pools and rosters. The old formula reconstructs the recorded draft priorities within 0.001. Starting WRs had about +3.0 performance points, compared with +2.5 for OL. Removing performance memory increased the CB imbalance, so that change was rejected.</p>
${table(
	[
		"Fixed-input sensitivity experiment",
		"WR expected choices",
		"OL expected choices",
		"DL expected choices",
		"CB expected choices",
	],
	diagnosis.results.map((r) => [
		r.name,
		...["WR", "OL", "DL", "CB"].map((p) => r.expected[p]!.toFixed(1)),
	]),
)}
<p class="note">These expected counts are separate one-pick calculations against unchanged saved pools, using the production selection probabilities. They are not sequential drafts: a highly valued receiver can be counted repeatedly while still appearing in several saved pools. The actual simulation results are in the first table.</p>
<h2>Changes and boundaries</h2><ul><li>Recruitment value per unit of roster improvement: WR 0.070 → 0.095, OL 0.090 → 0.075, CB 0.080 → 0.065. Other roles keep their weights. These also affect free agency, trade fit and retention.</li><li>A prospect just below the last starter no longer immediately loses 82% of his extra draft talent value. Opportunity falls gradually with the score gap, halves for each comparable reserve ahead of him, and is sharply discounted beyond the roster target. QB succession and specialists keep their existing rules.</li><li>The single 0–100 Starter Score, performance memory, rookie investment and lineup inertia are unchanged. A close prospect can be worth drafting while the incumbent still earns the starting job.</li><li>No position quotas or mandatory rookie starting/benching rules were added.</li></ul>
<h2>QB decisions and continuity</h2>${table(["Measure", "Previous", "Revised"], [...["rookieQBs", "actualRookieOpenerStarts", "observedRookieOpeners", "healthyRookiesBenchedInOpener", "OLPassingWR15", "abilityGap15"].map((k) => [({ rookieQBs: "First-round QBs", actualRookieOpenerStarts: "Actual rookie opening starts", observedRookieOpeners: "Observed rookie openers", healthyRookiesBenchedInOpener: "Healthy rookie QBs benched in opener", OLPassingWR15: "OL picks passing over WR with ≥15 more ability", abilityGap15: "All picks passing over any prospect with ≥15 more ability" } as Record<string, string>)[k], before.aggregate[k], after.aggregate[k]]), ...["healthyQBChanges", "immediateHealthyReversals", "multipleQBDrafts", "productiveIncumbentFlags", "mvpsStillStarting", "mvps"].map((k) => [({ healthyQBChanges: "Healthy QB switches", immediateHealthyReversals: "Immediate healthy reversals", multipleQBDrafts: "Team drafts selecting multiple QBs, all rounds", productiveIncumbentFlags: "First-round QBs with productive incumbent flag", mvpsStillStarting: "MVPs starting next opening snapshot", mvps: "MVPs observed" } as Record<string, string>)[k], before.safety[k], after.safety[k]])])}
<p>A productive-incumbent flag means at least 200 passing attempts and +3 performance points. It prompts inspection, not an automatic bad-pick verdict. Healthy switches count actual starting-QB changes within a season while both players were available.</p>
<p class="note">The comparison sample's rookie QB opening-start rate rises to 36/37 from 32/38, despite unchanged lineup rules. Only three drafted QBs ranked behind an incumbent, versus seven previously. Removing only draft-investment credit still leaves 34/37 leading their preseason group. This implicates which teams select QBs and the other score terms as well; it does not prove the investment bonus is harmless. Cincinnati's 52-ability rookie starts over a 62-ability veteran with nearly neutral performance credit, and the bonus tips that contest. Houston instead benches its 52-ability rookie behind a 68-ability, 34-year-old veteran. Both examples remain inspectable in the detailed audit. A blanket rookie penalty is not supported by this position-balance experiment.</p>
<h2>Roster coverage after offseasons</h2>${table(
	[
		"Role",
		"Average roster count previous / revised",
		"Underfilled starting groups previous / revised",
	],
	pos.map((p) => [
		p,
		`${rosterBefore[p]!.mean.toFixed(2)} / ${rosterAfter[p]!.mean.toFixed(2)}`,
		`${rosterBefore[p]!.short} / ${rosterAfter[p]!.short}`,
	]),
)}
<p>This checks 384 team-opening snapshots per version after recruitment, excluding the initial generated rosters. Counts use primary positions and do not measure contract efficiency or starting quality. It catches shortages but does not establish long-term salary-cap behavior.</p>
<h2>Evidence and validation</h2><p><a href="league-recruitment-after-audit.html">Previous: every pick and alternative</a> · <a href="league-recruitment-balanced-audit.html">Revised: every pick and alternative</a></p><p>562 ordinary tests pass, with 13 skipped. Six extended league tests pass independently, covering 5,226 games. Lint, TypeScript and the football production build pass. All league runs assert current decision snapshots and complete final-opening observations. Regression tests cover close receiver competitions, crowded depth, real OL needs, redundant QB investment, specialist discounts and incumbent protection.</p>
<details><summary>Reproduce the evidence</summary><p>Run <code>node --run test</code> and <code>node --run lint</code>. Set <code>SPORT=football</code> for <code>node --run build</code>. For each seed, set <code>STARTER_SCORE_RECRUITMENT=1</code>, <code>STARTER_SCORE_YEARS=3</code>, <code>STARTER_SCORE_SEED</code> and <code>STARTER_SCORE_LEAGUE_REPORT</code>, then run <code>pnpm exec vitest run --project football src/test/starterScoreLeague.football.test.ts --disableConsoleIntercept</code>.</p><p>Run <code>tools/analysis/auditStarterScoreRecruitment.ts</code> with the four balanced reports, setting <code>STARTER_SCORE_RECRUITMENT_PREFIX=league-recruitment-balanced</code> and <code>STARTER_SCORE_PACK_RECRUITMENT=1</code>; repeat with the two holdout reports and prefix <code>league-recruitment-holdout</code>. The diagnostic script <code>diagnoseFootballDraftBias.ts</code> accepts the four previous <code>league-recruitment-final-*.json.gz</code> reports. Finally run <code>node tools/analysis/reportFootballRecruitmentBalance.ts</code>. All paths are relative to the repository root. The saved compressed reports retain every pre-pick prospect pool and team roster, enabling inspection without rerunning the game.</p></details>
</main></body></html>`;
await fs.writeFile(
	"analysis/starter-score/recruitment-balance-findings.html",
	html,
);
console.log(
	JSON.stringify(
		{
			distanceBefore: totalDistance(before),
			distanceAfter: totalDistance(after),
			rosterBefore,
			rosterAfter,
		},
		null,
		2,
	),
);
