import fs from "node:fs/promises";
import { gunzipSync } from "node:zlib";

type Audit = {
	aggregate: Record<string, number> & {
		positions: Record<string, number>;
		supplyTop32Ability: Record<string, number>;
	};
	safety: Record<string, number>;
	rookieQBs: {
		team: string;
		seed: number;
		season: number;
		pick: number;
		actualOpenerStart: boolean | null;
		unavailableInOpener: boolean | null;
		rookie: { pid: number; score: Record<string, number> };
		best?: { pid: number; age: number; score: Record<string, number> };
	}[];
};
const read = async (file: string): Promise<Audit> =>
	JSON.parse(gunzipSync(await fs.readFile(file)).toString());
const before = await read(
	"analysis/starter-score/league-recruitment-before-audit.json.gz",
);
const after = await read(
	"analysis/starter-score/league-recruitment-after-audit.json.gz",
);
const esc = (v: unknown) =>
	String(v ?? "—")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll('"', "&quot;");
const table = (headers: string[], rows: unknown[][]) =>
	`<div class="table"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
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
const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(1)}%`;
const number = (v: number | undefined) => v?.toFixed(1) ?? "—";
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recruitment: talent, need and rookie QBs</title><style>body{margin:0;background:#f2f5f9;color:#182a40;font:16px/1.55 system-ui}main{max-width:1120px;padding:32px 24px 70px;margin:auto}h1{font-size:2.3rem;line-height:1.15}h2{margin-top:38px}p{max-width:95ch}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}td,th{padding:10px;border-bottom:1px solid #c6d0dd;text-align:left}th{background:#e2eaf4}a{color:#125caa}.note{padding:18px;background:white;border-left:4px solid #366ea6}.warning{border-color:#bb731d}li{margin:8px 0}code{font-size:14px}</style></head><body><main><h1>Recruitment: talent, need and rookie QBs</h1><p>Four generated leagues, three full seasons each, before and after a narrow change to draft priorities. Each version covers 12 drafts and 384 first-round selections. The revised runs also play the following opening week so every final-year drafted QB has an actual opener observation.</p><p class="note"><strong>Judgment:</strong> the AI was overvaluing modest improvements at weak starting slots, especially OL, and usually drafted QBs only when they already ranked first. The adjustment improves those decisions, but WR remains underselected and some QB investments still deserve scrutiny.</p><h2>Draft distribution</h2>${table(
	[
		"Role",
		"Before",
		"After",
		"Before %",
		"After %",
		"Supplied reference %",
		"Before top-32 ability supply",
		"After top-32 ability supply",
	],
	Object.entries(before.aggregate.positions).map(([pos, n]) => [
		pos,
		n,
		after.aggregate.positions[pos],
		pct(n, before.aggregate.picks!),
		pct(after.aggregate.positions[pos]!, after.aggregate.picks!),
		reference[pos] ?? "—",
		before.aggregate.supplyTop32Ability[pos],
		after.aggregate.supplyTop32Ability[pos],
	]),
)}<p>The supplied image is an approximate, unverified reference, not a target distribution. OT + interior OL map to OL; EDGE + DT are grouped as DL, imperfectly. Position counts, role definitions, generated talent and player development differ from the NFL. No quotas or automatic “15-point” rules were added.</p><h2>Why the change was warranted</h2><p>In the original Brooklyn 2027 decision (seed 20261005, pick 6), a 53-ability OL beat an available 70-ability WR. The OL improved the weakest starting slot by 16.1 Starter Score points; the WR improved a starting slot by 14.2. Both were useful additions. A small difference in need was outweighing a large difference in talent.</p>${table(
	["Same recorded decision", "OL", "WR"],
	[
		["Ability / potential", "53 / 72", "70 / 87"],
		["Original draft priority", "2.63", "2.23"],
		["Revised priority on those same recorded scores", "2.58", "3.07"],
	],
)}<p>The last row is a fixed-input recalculation, not a replay of the later league. A regression test reproduces the same tradeoff and also checks that a genuinely major OL hole can still win.</p><h2>What changed</h2><ul><li>The extra draft talent value grows faster for exceptional Starter Scores. It remains weighted by positional value and opportunity. The additional upside premium is capped for blocked backups.</li><li>A first QB backup can receive succession value behind a starter aged 31 or older, increasing with age. The candidate must be at most 24, and a comparable young backup closes the allowance. A prospect ranked third or lower does not receive it.</li><li>The underlying 0–100 player score, playing-time selection, performance memory and incumbent continuity are unchanged.</li></ul><h2>QB patience: measure games, not just depth lists</h2>${table(
	["Measure", "Before", "After"],
	[
		["First-round QBs", before.aggregate.rookieQBs, after.aggregate.rookieQBs],
		[
			"Already ranked first before drafting",
			before.aggregate.rookieQBs! - before.aggregate.draftedBackupQBs!,
			after.aggregate.rookieQBs! - after.aggregate.draftedBackupQBs!,
		],
		[
			"Leading next preseason depth chart",
			`${before.aggregate.rookieStarters}/${before.aggregate.rookieQBs}`,
			`${after.aggregate.rookieStarters}/${after.aggregate.rookieQBs}`,
		],
		[
			"Actual opening starts observed",
			`${before.aggregate.actualRookieOpenerStarts}/${before.aggregate.observedRookieOpeners}`,
			`${after.aggregate.actualRookieOpenerStarts}/${after.aggregate.observedRookieOpeners}`,
		],
		[
			"Healthy rookie benched in observed opener",
			before.aggregate.healthyRookiesBenchedInOpener,
			after.aggregate.healthyRookiesBenchedInOpener,
		],
	],
)}<p class="note warning">The baseline has actual openers for only the first two draft classes per league; the final class has preseason snapshots. The revised run includes every class's opener. Those actual-start percentages are different observation windows, not a matched before/after estimate. Miami's revised rookie was second on the preseason chart but started the opener, demonstrating why the distinction matters.</p><p>In the earlier two-league sample, removing every QB's draft-investment bonus still left all 12 selected rookies ranked first at the following opening snapshot. The expanded unchanged sample also included two first-round QBs behind veterans. The evidence did not justify a blanket rookie starting penalty.</p><h2>Healthy rookies who actually began behind veterans in the revised runs</h2>${table(
	[
		"Team / draft / seed",
		"Pick",
		"Rookie ability / potential",
		"Veteran age / ability",
		"Opening snapshot scores (rookie / veteran)",
	],
	after.rookieQBs
		.filter(
			(q) => q.actualOpenerStart === false && q.unavailableInOpener === false,
		)
		.map((q) => [
			`${q.team} ${q.season} (${q.seed})`,
			q.pick,
			`${q.rookie.score.ability} / ${q.rookie.score.potential}`,
			`${q.best?.age} / ${q.best?.score.ability}`,
			`${number(q.rookie.score.score)} / ${number(q.best?.score.score)}`,
		]),
)}<h2>Remaining concerns and checks</h2>${table(
	["Measure", "Before", "After"],
	[
		[
			"OL picks with WR ≥15 ability points stronger available",
			before.aggregate.OLPassingWR15,
			after.aggregate.OLPassingWR15,
		],
		[
			"All selections with some available prospect ≥15 ability points stronger",
			before.aggregate.abilityGap15,
			after.aggregate.abilityGap15,
		],
		[
			"Team drafts selecting multiple QBs, all rounds",
			before.safety.multipleQBDrafts,
			after.safety.multipleQBDrafts,
		],
		[
			"First-round QB picks with productive-incumbent flag",
			before.safety.productiveIncumbentFlags,
			after.safety.productiveIncumbentFlags,
		],
		[
			"Healthy QB switches",
			before.safety.healthyQBChanges,
			after.safety.healthyQBChanges,
		],
		[
			"Immediate healthy reversals",
			before.safety.immediateHealthyReversals,
			after.safety.immediateHealthyReversals,
		],
		[
			"MVPs starting at next opening snapshot",
			`${before.safety.mvpsStillStarting}/${before.safety.mvps}`,
			`${after.safety.mvpsStillStarting}/${after.safety.mvps}`,
		],
	],
)}<p>WR rises only from 3.6% to 4.7%, still far below the supplied 12% reference despite substantial WR talent in the generated classes. OL remains high, and CB barely changes. This is a partial improvement, not a completed position-balance calibration.</p><p>Multiple-QB drafts rose from 9 to 13; every second QB in the revised duplicate cases was selected in round three or later. That is less troubling than two premium picks, but it is not automatically good roster building. Productive-incumbent flags also rose: some are credible older-veteran succession plans or exceptional upgrades; Chicago's late first-round project behind a successful young QB remains questionable.</p><p>The productive flag requires at least 200 passing attempts and +3 performance points. The 15-point screen is diagnostic, not a definition of a bad pick: position, opportunity and team needs still matter. Longer-term cap use, roster cleanup and the unresolved WR/CB imbalance are not established by this experiment.</p><h2>Evidence and validation</h2><p>The draft observer stores the entire available prospect pool and current roster before each first-round selection. It reproduced all games and checkpoints exactly for the two previously saved seeds. Subsequent outcomes diverge between formulas as acquisitions change the random stream. These are fictional game-generated leagues on 100-yard fields, not imported NFL rosters or a stock-AI comparison.</p><p>560 ordinary tests pass, with 13 skipped; the extended league runs additionally assert that all 32 teams' following openers were observed and that no weekly decision snapshots were stale. Source lint, TypeScript and the football production build are checked separately.</p><p><a href="league-recruitment-before-audit.html">Every original pick and alternative</a> · <a href="league-recruitment-after-audit.html">Every revised pick and alternative</a></p></main></body></html>`;
await fs.writeFile("analysis/starter-score/recruitment-findings.html", html);
console.log("Wrote analysis/starter-score/recruitment-findings.html");
