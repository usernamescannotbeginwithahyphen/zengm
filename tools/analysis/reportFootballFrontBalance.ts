import fs from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

type Prospect = {
	pid: number;
	pos: string;
	score: { ability: number; potential: number; score: number };
	fit: { starterGain: number; draftValue: number };
};
type Pick = {
	seed: number;
	season: number;
	tid: number;
	team: string;
	pick: number;
	chosen: Prospect;
	chosenRole: { rank: number };
	alternatives: Prospect[];
	bestAbility: Prospect;
	abilityGap: number;
};
type Audit = {
	aggregate: {
		positions: Record<string, number>;
		supplyTop32Ability: Record<string, number>;
		[key: string]: number | Record<string, number>;
	};
	safety: Record<string, number>;
	decisions: Pick[];
	multipleQBDrafts: { seed: number; pids: number[] }[];
};
type Raw = {
	seed: number;
	players: { pid: number; draft: { round: number } }[];
	draftDecisions: {
		season: number;
		tid: number;
		pick: number;
		pid: number;
		candidates: Prospect[];
	}[];
	checkpoints: {
		season: number;
		label: string;
		teams: {
			tid: number;
			name: string;
			rosterCounts: Record<string, number>;
		}[];
	}[];
};
const read = async <T>(path: string): Promise<T> =>
	JSON.parse(
		gunzipSync(
			await fs.readFile(`analysis/starter-score/${path}.json.gz`),
		).toString(),
	);
const previous = await Promise.all(
	["league-recruitment-balanced-audit", "league-recruitment-holdout-audit"].map(
		(p) => read<Audit>(p),
	),
);
const trialAudit = [await read<Audit>("league-recruitment-front-audit")];
const revised = [await read<Audit>("league-recruitment-front-final-audit")];
const seeds = [20261005, 20261006, 20261007, 20261008, 20261009, 20261010];
const rawBefore = await Promise.all(
	seeds.map((seed) =>
		read<Raw>(
			`league-recruitment-${seed <= 20261008 ? "balanced" : "holdout"}-${seed}`,
		),
	),
);
const rawAfter = await Promise.all(
	seeds.map((seed) => read<Raw>(`league-recruitment-front-final-${seed}`)),
);
const rawTrial = await Promise.all(
	seeds.map((seed) => read<Raw>(`league-recruitment-front-${seed}`)),
);
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
const summarize = (audits: Audit[], raw: Raw[]) => {
	const picks = audits.flatMap((r) => r.decisions);
	const positions = Object.fromEntries(
		Object.keys(starters).map((pos) => [
			pos,
			picks.filter((p) => p.chosen.pos === pos).length,
		]),
	);
	const supply = Object.fromEntries(
		Object.keys(starters).map((pos) => [
			pos,
			audits.reduce((n, r) => n + r.aggregate.supplyTop32Ability[pos]!, 0),
		]),
	);
	const measures = Object.fromEntries(
		[
			"rookieQBs",
			"actualRookieOpenerStarts",
			"observedRookieOpeners",
			"healthyRookiesBenchedInOpener",
			"OLPassingWR15",
			"abilityGap15",
		].map((k) => [
			k,
			audits.reduce((n, r) => n + (r.aggregate[k] as number), 0),
		]),
	);
	const safety = Object.fromEntries(
		Object.keys(audits[0]!.safety).map((k) => [
			k,
			audits.reduce((n, r) => n + r.safety[k]!, 0),
		]),
	);
	const openingTeams = raw.flatMap((r) =>
		r.checkpoints
			.filter(
				(c) =>
					(c.label === "opening" && c.season > r.checkpoints[0]!.season) ||
					c.label === "final-opening",
			)
			.flatMap((c) => c.teams),
	);
	const coverage = Object.fromEntries(
		Object.keys(starters).map((p) => [
			p,
			{
				mean:
					openingTeams.reduce((n, t) => n + t.rosterCounts[p]!, 0) /
					openingTeams.length,
				short: openingTeams.filter((t) => t.rosterCounts[p]! < starters[p]!)
					.length,
			},
		]),
	);
	const flags = raw.flatMap((r) =>
		r.draftDecisions.flatMap((d) => {
			const chosen = d.candidates.find((p) => p.pid === d.pid)!;
			const alternative = d.candidates
				.filter(
					(p) =>
						p.pos !== "K" &&
						p.pos !== "P" &&
						p.score.ability >= chosen.score.ability + 15 &&
						p.fit.starterGain > chosen.fit.starterGain,
				)
				.sort((a, b) => b.fit.draftValue - a.fit.draftValue)[0];
			return alternative
				? [
						{
							seed: r.seed,
							season: d.season,
							tid: d.tid,
							pick: d.pick,
							team: r.checkpoints[0]!.teams.find((t) => t.tid === d.tid)!.name,
							chosen,
							alternative,
						},
					]
				: [];
		}),
	);
	const secondQBRounds: Record<number, number> = {};
	for (const d of audits.flatMap((a) => a.multipleQBDrafts)) {
		const r = raw.find((r) => r.seed === d.seed)!;
		const rounds = d.pids
			.map((pid) => r.players.find((p) => p.pid === pid)!.draft.round)
			.sort((a, b) => a - b);
		const second = rounds[1]!;
		secondQBRounds[second] = (secondQBRounds[second] ?? 0) + 1;
	}
	return {
		positions,
		supply,
		measures,
		safety,
		coverage,
		openingSnapshots: openingTeams.length,
		picks,
		flags,
		secondQBRounds,
	};
};
const before = summarize(previous, rawBefore),
	trial = summarize(trialAudit, rawTrial),
	after = summarize(revised, rawAfter);
if (
	before.picks.length !== 576 ||
	trial.picks.length !== 576 ||
	after.picks.length !== 576 ||
	before.openingSnapshots !== 576 ||
	after.openingSnapshots !== 576
) {
	throw new Error(
		"Expected six complete, three-season leagues for each revision",
	);
}
const pct = (n: number, total = 576) => `${((100 * n) / total).toFixed(1)}%`;
const esc = (v: unknown) =>
	String(v ?? "—")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll('"', "&quot;");
const table = (headers: string[], rows: unknown[][]) =>
	`<div class="table"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const distance = (s: typeof before) =>
	Object.entries(reference).reduce(
		(n, [p, ref]) =>
			n + Math.abs((100 * s.positions[p]!) / s.picks.length - ref),
		0,
	);
const count = (s: typeof before, seed: number, pos: string) =>
	s.picks.filter((d) => d.seed === seed && d.chosen.pos === pos).length;
const mean = (ns: number[]) =>
	ns.length ? (ns.reduce((a, b) => a + b, 0) / ns.length).toFixed(1) : "—";
const sensitivity = await read<{
	method: string;
	results: { name: string; expected: Record<string, number> }[];
}>("league-position-weight-sensitivity");
const summary = {
	baselineRevision: "5f8b9151d",
	productionWeightsRetained: true,
	decision:
		"Neither experiment established a clear improvement over the baseline. Both weight changes were reverted; the regression scenario and traded-rookie audit fix are retained.",
	seeds,
	years: 3,
	before: { ...before, picks: undefined },
	trial: { ...trial, picks: undefined },
	after: { ...after, picks: undefined },
	distanceBefore: distance(before),
	distanceTrial: distance(trial),
	distanceAfter: distance(after),
};
await fs.writeFile(
	"analysis/starter-score/league-recruitment-front-comparison.json.gz",
	gzipSync(JSON.stringify(summary)),
);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Two recruitment experiments: defensive line and secondary</title><style>body{margin:0;background:#f2f5f9;color:#182a40;font:16px/1.55 system-ui}main{max-width:1140px;padding:32px 24px 70px;margin:auto}h1{font-size:2.3rem;line-height:1.15}h2{margin-top:38px}p{max-width:95ch}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}td,th{padding:10px;border-bottom:1px solid #c6d0dd;text-align:left}th{background:#e2eaf4}a{color:#125caa}.note{padding:18px;background:white;border-left:4px solid #366ea6}li{margin:8px 0}code{overflow-wrap:anywhere}</style></head><body><main>
<h1>Two recruitment experiments: defensive line and secondary</h1>
<p class="note"><strong>Decision: retain the previous production weights.</strong> The stronger trial improved DL and safety shares but introduced an unattractive first-overall DL-over-CB choice. The conservative trial protected that talent preference while shifting more selections toward OL and CB. Neither established a clear overall improvement. The new regression scenario and audit support for traded rookies are retained; both simulation variants remain available for inspection.</p>
<p>Six generated leagues per version, three full seasons each plus the following opening week: 18 drafts, 576 first-round picks and ${after.safety.games?.toLocaleString()} games in each version. Previous is revision 5f8b9151d. The seed set is identical, but acquisitions alter later random draws and prospect pools. These are fictional game-generated rosters using the normal football simulation on 100-yard fields.</p>
<h2>First-round selections</h2>${table(
	[
		"Position",
		"Previous %",
		"Stronger trial %",
		"Conservative trial %",
		"Conservative trial picks",
		"Supplied reference %",
		"Top-32 ability supply previous / revised",
	],
	Object.keys(starters).map((p) => [
		p,
		pct(before.positions[p]!),
		pct(trial.positions[p]!),
		pct(after.positions[p]!),
		after.positions[p],
		reference[p] ?? "—",
		`${before.supply[p]} / ${after.supply[p]}`,
	]),
)}
<p>The summed absolute gap from the nine supplied position percentages is ${distance(before).toFixed(1)} for the previous version, ${distance(trial).toFixed(1)} for the stronger trial, and ${distance(after).toFixed(1)} for the conservative trial. This describes the result; it is not a significance test or an objective used to optimize the weights. The supplied reference is approximate and unverified; grouping OT/IOL as OL and EDGE/DT as DL is imperfect. RB share and rookie QB starts are secondary checks for this round, following the user's priorities. Below, “revised” refers to the conservative experiment, not the retained production settings.</p>
<h2>What changed</h2><ul><li>The conservative trial increased DL recruitment weight from 0.100 to 0.105 and decreased safety from 0.065 to 0.055. CB remains at 0.065 and OL at 0.075.</li><li>The stronger trial used DL 0.115 and CB 0.060. It barely reduced CB share and produced Phoenix's first-overall DL selection at 57 ability / 79 potential over an available CB at 74 / 91 who also offered a larger starting-score improvement. On those exact saved inputs, restoring CB and moderating DL changes draft priorities from DL 4.086 vs CB 3.690 to DL 3.731 vs CB 3.998. This is a fixed-input recalculation, not the later simulated outcome.</li><li>An OL reduction to 0.070 failed the existing severe-hole regression case. A new controlled scenario inspired by Phoenix also rejected DL 0.110 with CB 0.065; DL 0.105 preserves that exceptional-CB preference. No universal rating-gap rule was added.</li><li>The weights apply to roster acquisition and retention. The single 0–100 Starter Score, performance memory, lineup inertia, rookie investment, QB succession and close-challenger draft opportunity retain their existing formulas.</li></ul>
<h2>Results by league</h2>${table(
	[
		"Seed",
		"WR previous → revised",
		"OL previous → revised",
		"DL previous → revised",
		"CB previous → revised",
		"S previous → revised",
	],
	seeds.map((seed) => [
		seed,
		...["WR", "OL", "DL", "CB", "S"].map(
			(p) => `${count(before, seed, p)} → ${count(after, seed, p)}`,
		),
	]),
)}
<p>Each row covers 96 picks. These six seeds were used for the diagnostic and simulations; they are a comparison sample, not an independent holdout.</p>
<p>The remaining CB share is partly a supply question: the prior version's classes contain 110 CBs among 576 top-32-ability slots (19.1%), compared with 103 CB selections (17.9%). OL is different: 88 top-32-ability slots (15.3%) yield 126 selections (21.9%). Those controls suggest examining prospect generation and weak starting slots separately; lowering both positions' recruitment weights did not reliably solve the distribution.</p>
<h2>Talent and need checks</h2>${table(
	[
		"Position",
		"Average selected ability previous / revised",
		"Average starting-score gain previous / revised",
	],
	Object.keys(starters).map((p) => {
		const b = before.picks.filter((d) => d.chosen.pos === p),
			a = after.picks.filter((d) => d.chosen.pos === p);
		return [
			p,
			`${mean(b.map((d) => d.chosen.score.ability))} / ${mean(a.map((d) => d.chosen.score.ability))}`,
			`${mean(b.map((d) => d.chosen.fit.starterGain))} / ${mean(a.map((d) => d.chosen.fit.starterGain))}`,
		];
	}),
)}
<p>Choices passing over a non-specialist with at least 15 more ability points AND a larger immediate starting-score gain: ${before.flags.length} previous, ${after.flags.length} revised. Of these, DL selections account for ${before.flags.filter((d) => d.chosen.pos === "DL").length} and ${after.flags.filter((d) => d.chosen.pos === "DL").length}. This is a review screen, not a rule that defines good or bad drafting; positional value, potential and depth still matter. Every revised flag is listed below.</p>${table(
	[
		"Team / draft / seed",
		"Pick",
		"Chosen role / ability / potential",
		"Alternative role / ability / potential",
		"Starting-score gain chosen / alternative",
	],
	after.flags.map((d) => [
		`${d.team} ${d.season} (${d.seed})`,
		d.pick,
		`${d.chosen.pos} / ${d.chosen.score.ability} / ${d.chosen.score.potential}`,
		`${d.alternative.pos} / ${d.alternative.score.ability} / ${d.alternative.score.potential}`,
		`${d.chosen.fit.starterGain.toFixed(1)} / ${d.alternative.fit.starterGain.toFixed(1)}`,
	]),
)}
<h2>Roster coverage and continuity</h2>${table(
	[
		"Role",
		"Average roster count previous / revised",
		"Underfilled starting groups previous / revised",
	],
	Object.keys(starters).map((p) => [
		p,
		`${before.coverage[p]!.mean.toFixed(2)} / ${after.coverage[p]!.mean.toFixed(2)}`,
		`${before.coverage[p]!.short} / ${after.coverage[p]!.short}`,
	]),
)}
<p>Coverage uses 576 post-recruitment team-opening snapshots per version, excluding initial generated rosters. Counts use primary positions. They catch shortages but do not establish contract efficiency or long-term cap health.</p>${table(["Check", "Previous", "Revised"], [...["rookieQBs", "actualRookieOpenerStarts", "observedRookieOpeners", "healthyRookiesBenchedInOpener", "OLPassingWR15"].map((k) => [({ rookieQBs: "First-round QBs", actualRookieOpenerStarts: "Rookie QBs starting their opener", observedRookieOpeners: "Observed rookie QB openers", healthyRookiesBenchedInOpener: "Healthy rookie QBs benched in opener", OLPassingWR15: "OL picks passing over a WR with ≥15 more ability" } as Record<string, string>)[k], before.measures[k], after.measures[k]]), ...["healthyQBChanges", "immediateHealthyReversals", "multipleQBDrafts", "productiveIncumbentFlags", "mvpsStillStarting", "mvps"].map((k) => [({ healthyQBChanges: "Healthy QB changes", immediateHealthyReversals: "Immediate healthy QB reversals", multipleQBDrafts: "Team drafts selecting multiple QBs, all rounds", productiveIncumbentFlags: "First-round QBs behind productive incumbents", mvpsStillStarting: "MVPs still starting next opening snapshot", mvps: "MVPs observed" } as Record<string, string>)[k], before.safety[k], after.safety[k]])])}
<p>A productive-incumbent flag requires at least 200 passing attempts and +3 performance credit. It is an inspection aid, not a verdict. Immediate reversals measure actual QB starts, not every position's rotation.</p><p>In revised team drafts with multiple QBs, the second QB was selected in these rounds: ${Object.entries(
	after.secondQBRounds,
)
	.map(([round, n]) => `round ${round}: ${n} drafts`)
	.join(
		"; ",
	)}. The stronger trial had ${trial.safety.multipleQBDrafts} such drafts versus ${before.safety.multipleQBDrafts} previously; its extra QB picks all came in round four or later.</p>
<details><summary>Fixed-input sensitivity checks</summary><p>${esc(sensitivity.method)}</p>${table(
	[
		"Experiment",
		"Expected OL choices",
		"Expected DL choices",
		"Expected CB choices",
		"Expected S choices",
	],
	sensitivity.results.map((r) => [
		r.name,
		...["OL", "DL", "CB", "S"].map((p) => r.expected[p]!.toFixed(1)),
	]),
)}<p>The “OL and CB only” experiment includes the rejected OL weight. “Combined” is the stronger trial; “Conservative trial” matches the conservative trial. Both ran through six complete three-season leagues.</p></details>
<h2>Evidence and reproduction</h2><p><a href="league-recruitment-balanced-audit.html">Previous seeds 05–08</a> · <a href="league-recruitment-holdout-audit.html">Previous seeds 09–10</a> · <a href="league-recruitment-front-audit.html">Stronger trial</a> · <a href="league-recruitment-front-final-audit.html">All conservative trial decisions and alternatives</a></p><p>563 ordinary tests pass, with 13 skipped. Both experiments passed all six extended league tests, totaling 10,452 simulated games. Lint, TypeScript and the football build pass. The traded-rookie fix follows Philadelphia's 2027 pick 4 to Nashville's actual opening game; missing roster evidence is recorded separately from benching.</p><p>Run the opt-in <code>src/test/starterScoreLeague.football.test.ts</code> with <code>STARTER_SCORE_RECRUITMENT=1</code>, <code>STARTER_SCORE_YEARS=3</code>, each seed and a report path. Analyze the six conservative-trial reports with <code>tools/analysis/auditStarterScoreRecruitment.ts</code>, prefix <code>league-recruitment-front-final</code>, and packing enabled. <code>node tools/analysis/reportFootballFrontBalance.ts</code> regenerates this comparison from the saved compressed evidence. Run <code>node --run lint</code>, <code>node --run test</code>, and <code>SPORT=football node --run build</code> (set the variable separately in PowerShell) for validation. Production retains the baseline weights, so reproducing either experiment's simulations requires temporarily applying its listed weights; analyzing the saved evidence does not.</p>
</main></body></html>`;
await fs.writeFile(
	"analysis/starter-score/recruitment-front-findings.html",
	html,
);
console.log(
	JSON.stringify(
		{
			...summary,
			before: { ...summary.before, flags: summary.before.flags.length },
			after: { ...summary.after, flags: summary.after.flags.length },
		},
		null,
		2,
	),
);
