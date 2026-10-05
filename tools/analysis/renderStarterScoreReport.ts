import fs from "node:fs/promises";

type Score = { score: number; performance: number; continuity: number };
type Trace = {
	week: number;
	selected: string;
	depthLeader: string;
	injured: boolean[];
	scores: Score[];
};
type Trajectory = {
	id: string;
	role?: string;
	description: string;
	initialSelection: string;
	profiles: {
		name: string;
		ability: number;
		age?: number;
		potential?: number;
		salary?: number;
		prior?: Record<string, number>;
	}[];
	changes: { afterGame: number; to: string }[];
	trace: Trace[];
};
type Report = {
	methodology: string;
	lines: Record<string, Record<string, number>>;
	trajectories: Trajectory[];
	sweep: {
		gap: number;
		history: string;
		pattern: string;
		switches: number;
		changes: { afterGame: number; to: string }[];
	}[];
	positions: {
		pos: string;
		inputs: Record<string, Record<string, number>>;
		noEvidence: Score;
		good: Score;
		poor: Score;
		withAdded?: Score;
	}[];
	positionThresholds?: Trajectory[];
	acquisitions: {
		scores: {
			name: string;
			value: number;
			draftValue: number;
			starterGain: number;
			affordableRole: boolean;
		}[];
		preferredFreeAgent: string;
		beforeSuccessor: number;
		afterSuccessor: number;
	};
};
const directory = new URL("../../analysis/starter-score/", import.meta.url);
const before = JSON.parse(
	await fs.readFile(new URL("before.json", directory), "utf8"),
) as Report;
const after = JSON.parse(
	await fs.readFile(new URL("after.json", directory), "utf8"),
) as Report;
const esc = (s: unknown) =>
	String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
const n = (value: number) => value.toFixed(2);
const table = (headers: string[], rows: unknown[][]) =>
	`<div class="table-wrap"><table><thead><tr>${headers.map((s) => `<th>${esc(s)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const summary = (row: Trajectory) =>
	`${row.initialSelection} initially; ${row.changes.length ? row.changes.map((change) => `${change.to} after game ${change.afterGame}`).join("; ") : "no changes in 17 games"}`;
const line = (stats: Record<string, number>) =>
	Object.entries(stats)
		.map(([k, v]) => `${k}=${v}`)
		.join(", ");
const switchWeeks = (row: Report["sweep"][number]) =>
	row.changes.map((change) => change.afterGame).join(", ") || "None";

const graph = (row: Trajectory) => {
	const values = row.trace.flatMap((point) =>
		point.scores.map((score) => score.score),
	);
	const low = Math.max(0, Math.floor((Math.min(...values) - 3) / 5) * 5);
	const high = Math.min(100, Math.ceil((Math.max(...values) + 3) / 5) * 5);
	const x = (week: number) => 65 + (week / 17) * 500;
	const y = (score: number) => 190 - ((score - low) / (high - low)) * 155;
	let svg = `<svg viewBox="0 0 600 240" role="img" aria-label="${esc(row.id)}: weekly Starter Scores. Exact values are in the following table."><rect x="65" y="35" width="500" height="155" class="frame"/>`;
	for (let i = 0; i <= 4; i++) {
		const tick = low + ((high - low) * i) / 4;
		svg += `<text x="56" y="${y(tick) + 4}" text-anchor="end">${tick.toFixed(1)}</text>`;
	}
	for (const tick of [0, 4, 8, 12, 16]) {
		svg += `<text x="${x(tick)}" y="208" text-anchor="middle">${tick}</text>`;
	}
	svg += `<text x="315" y="233" text-anchor="middle">Games completed · decision for the next game</text><text x="18" y="118" transform="rotate(-90 18 118)" text-anchor="middle">Starter Score</text>`;
	for (const [index, profile] of row.profiles.entries()) {
		svg += `<polyline class="series s${index}" points="${row.trace.map((point) => `${x(point.week)},${y(point.scores[index]!.score)}`).join(" ")}"/>`;
		svg += `<text x="${65 + index * 260}" y="20" class="label${index}">${esc(profile.name)}</text>`;
		for (const point of row.trace) {
			if (point.selected === profile.name) {
				svg += `<circle class="dot s${index}" cx="${x(point.week)}" cy="${y(point.scores[index]!.score)}" r="3.5"/>`;
			}
		}
	}
	return svg + "</svg>";
};
const positionNotes: Record<string, string> = {
	QB: "Passing yards/TD/INT/sacks, rushing yards/TD, lost fumbles. Completion percentage is not a separate bonus; sack rate and yardage efficiency already contribute.",
	RB: "Rushing plus receiving yards and TDs, targets (including incompletions), and lost fumbles. Lower receiving baseline than WR reflects shorter routes.",
	WR: "Receiving per target, rushing/end-arounds, both kinds of TD, lost fumbles. No reliable drop or route-separation data.",
	TE: "Receiving, rushing, fumbles, and pass/run blocking. Blocking opportunities carry one tenth the sample weight of targets. Good-but-less-exceptional blocking can dilute exceptional receiving efficiency.",
	OL: "Pass/run block wins, attempts, sacks allowed. Current benchmark combines pass and run blocking; scheme/opponent adjustments remain absent.",
	DL: "Tackles, sacks, non-sack TFL, INT, defended passes, forced/recovered fumbles, safeties. Low production is only a modest negative proxy; no pressures or double-team data.",
	LB: "Same recorded defensive contributions with a different tackle baseline. No missed-tackle or assignment-error data; negative influence is deliberately limited.",
	CB: "Recorded tackles and disruptive plays earn credit. Quiet coverage is neutral because targets and yards/TD allowed are not recorded.",
	S: "Same conservative coverage treatment as CB. Tackles, sacks and turnovers count, but box scores cannot detect blown coverages.",
	K: "FG success against distance-bucket expectations, plus extra points. Kickoffs are not graded because touchbacks alone do not establish good placement.",
	P: "Punt distance, inside-20 placements, touchbacks, and blocked punts when recorded. No net-return yardage or situational field-position normalization.",
	KR: "Return yards and TDs with return-count confidence. No starting-field-position or blocking-quality adjustment.",
	PR: "Return yards and TDs. Yardage deviations have a larger scale than KR. Fumbles are not assigned here because the stored total does not identify return fumbles.",
};
const worstBefore = Math.max(...before.sweep.map((row) => row.switches));
const worstAfter = Math.max(...after.sweep.map((row) => row.switches));
const caseRows = after.trajectories.map((row) => [
	row.id,
	summary(before.trajectories.find((old) => old.id === row.id)!),
	summary(row),
]);
const thresholdRows = after.positions.map((row) => {
	const threshold = after.positionThresholds?.find(
		(trace) => trace.id === row.pos,
	);
	return [
		row.pos,
		n(row.noEvidence.score),
		n(row.good.score),
		n(row.poor.score),
		row.withAdded ? n(row.withAdded.score) : "—",
		threshold?.changes[0]?.afterGame ?? "No switch in 17",
	];
});
const traceDetails = after.trajectories
	.map(
		(row) =>
			`<details><summary>${esc(row.id)} — ${esc(summary(row))}</summary><p>${esc(row.description)}</p>${table(
				["Player", "Ability", "Potential", "Age", "Annual salary"],
				row.profiles.map((p) => [
					p.name,
					p.ability,
					p.potential ?? p.ability,
					p.age ?? 28,
					"$" + ((p.salary ?? 500) / 1000).toFixed(1) + "m",
				]),
			)}${graph(row)}<p>Dots identify the available player selected for the next game. Injury replacements can differ from the depth-chart leader. Scores are evaluated before applying that row’s new depth order; the next evaluation reflects the new incumbent.</p>${table(
				[
					"After game",
					"Selected",
					"Depth leader",
					"Score A",
					"Score B",
					"Performance A",
					"Performance B",
					"Continuity A",
					"Continuity B",
				],
				row.trace.map((t) => [
					t.week,
					t.selected,
					t.depthLeader,
					...t.scores.map((s) => n(s.score)),
					...t.scores.map((s) => n(s.performance)),
					...t.scores.map((s) => n(s.continuity)),
				]),
			)}</details>`,
	)
	.join("");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Starter Score scenario audit</title><style>
:root {color-scheme:light dark;font:16px/1.55 system-ui;--blue:light-dark(#175cb4,#7eb9ff);--orange:light-dark(#a04400,#ffb279)} body{margin:0;background:Canvas;color:CanvasText} main{max-width:1100px;margin:auto;padding:32px 24px 80px} h1{font-size:2rem;line-height:1.15} h2{margin-top:40px;font-size:1.35rem} p{max-width:85ch} a{color:var(--blue)} .table-wrap{overflow:auto;margin:20px 0} table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14px} th,td{padding:10px 12px;border-bottom:1px solid color-mix(in srgb,CanvasText 25%,Canvas);text-align:left;vertical-align:top} th{font-weight:650} details{border-top:1px solid color-mix(in srgb,CanvasText 25%,Canvas);padding:16px 0} summary{cursor:pointer;font-weight:650} svg{display:block;width:100%;max-width:800px;height:auto} svg text{fill:CanvasText;font:12px system-ui} .frame{fill:none;stroke:color-mix(in srgb,CanvasText 35%,Canvas)} .series{fill:none;stroke-width:2.5} .s0{stroke:var(--blue)} .s1{stroke:var(--orange)} .dot.s0{fill:var(--blue)} .dot.s1{fill:var(--orange)} .label0{fill:var(--blue)} .label1{fill:var(--orange)} code{font-size:.9em} @media(max-width:600px){main{padding:18px 12px}h1{font-size:1.65rem}} @media print{details{break-inside:avoid}main{max-width:none}.table-wrap{overflow:visible}}
</style></head><body><main><h1>Starter Score: dummy-roster scenario audit</h1><p>Baseline: commit <code>1020dac55</code>. Revised model: October 5, 2026. All numbers come from the production scoring and sorting functions, not a second implementation of the formula.</p>
<p><strong>The original inertia was insufficient in the stress tests.</strong> The worst QB competition produced ${worstBefore} changes in 17 games. After preserving a minimum incumbent preference and slowing recent form, the worst of the same 30 cases produces ${worstAfter}. This is a controlled diagnostic grid, not an estimate of how frequently real simulated leagues will change starters.</p>
<p>${esc(after.methodology)}</p>
<h2>Decisions before and after</h2>${table(["Scenario", "Original model", "Revised model"], caseRows)}
<p>The recovery scenario forces an injury opportunity for the prospect after game 6. He earns the higher depth-chart position after game 9 and retains it when the veteran becomes available after game 10. DNPs themselves do not improve his form.</p>
<h2>Weekly scores and thresholds</h2><p>Expand a scenario for its player inputs, score curves, and complete decision log. No real historical player's ratings were estimated.</p><details><summary>QB box scores used in these scenarios</summary>${table(
	[
		"Line",
		"Completions / attempts",
		"Yards",
		"TD",
		"INT",
		"Sacks / yards lost",
	],
	Object.entries(after.lines).map(([name, stats]) => [
		name,
		`${stats.pssCmp ?? 0} / ${stats.pss ?? 0}`,
		stats.pssYds ?? 0,
		stats.pssTD ?? 0,
		stats.pssInt ?? 0,
		`${stats.pssSk ?? 0} / ${stats.pssSkYds ?? 0}`,
	]),
)}</details>${traceDetails}
<h2>Every position</h2><p>Score columns compare an otherwise identical 65-rated player after eight repeated good or poor games. “Added” includes the secondary production listed below. The benching threshold is a separate test: a 67-rated incumbent with a good prior season and $4m contract against a 64-rated reserve. Other starting slots are filled, so WR, OL and defensive groups are not treated as one-player positions. Quiet defensive stat lines are not proof of poor defense.</p>${table(["Role", "No evidence", "Good", "Poor/quiet", "Good + added", "Poor games before benching"], thresholdRows)}
<p>KR/PR fixtures use wide receivers with return-role ability. Their lower absolute scores include the existing 15-point preference for a player's primary position; compare players within a role, rather than comparing these scores directly with quarterbacks.</p>
${after.positions
	.map(
		(row) =>
			`<details><summary>${esc(row.pos)} — inputs and limitations</summary><p>${esc(positionNotes[row.pos])}</p>${table(
				["Condition", "Per-game input"],
				Object.entries(row.inputs).map(([key, value]) => [key, line(value)]),
			)}</details>`,
	)
	.join("")}
<h2>Roster-building choice</h2><p>The team already has a productive 73-rated QB and a newly drafted 60/85 successor, but five 40-rated starting linemen. It compares another 70/85 QB asking $15m, a 65/80 OL asking $10m, and a 100-rated punter asking the minimum. Numbers below are changes in weighted team utility derived from Starter Scores; they are not extra player ratings.</p>${table(
	[
		"Candidate",
		"Roster improvement",
		"Draft weight before exponent",
		"Starter gain",
		"Affordable for role",
	],
	after.acquisitions.scores.map((row) => [
		row.name,
		n(row.value),
		n(row.draftValue),
		n(row.starterGain),
		row.affordableRole ? "Yes" : "No",
	]),
)}<p>Free-agent choice: <strong>${esc(after.acquisitions.preferredFreeAgent)}</strong>. Adding the young successor reduces another QB's roster improvement from ${n(after.acquisitions.beforeSuccessor)} to ${n(after.acquisitions.afterSuccessor)}. The real draft applies its existing randomized selection exponent to the draft weights. A missing position now gets its ordinary vacancy value without being counted again as injury cover.</p>
<h2>30-case QB churn stress test</h2><p>Ability gap is incumbent minus challenger. History belongs to the incumbent; the challenger starts without recorded performance. Whichever player starts receives the specified full-game line. “Alternating” means good and poor games by calendar week; “poor” means both quarterbacks struggle whenever used. Record remains fixed at 8–4 to isolate score behavior.</p>${table(
	[
		"Ability gap",
		"Prior history",
		"Pattern",
		"Original switches",
		"Revised switches",
		"Revised switch after games",
	],
	after.sweep.map((row, i) => [
		row.gap,
		row.history,
		row.pattern,
		before.sweep[i]!.switches,
		row.switches,
		switchWeeks(row),
	]),
)}
<h2>What I would and would not trust</h2><p>The revised QB decisions and duplicate-acquisition restraint are plausible in these fixtures. This caught a real churn bug that the earlier one-step tests missed. It does not establish realistic behavior across full generated leagues. Some unestablished or weaker incumbents still lose their job after one poor game; there is no hard minimum starting stint. The TE fixture waits nine poor games, which may be too patient. Coverage failure cannot be inferred from the currently recorded defensive stats. Position benchmarks are still fixed, with a short-field adjustment; league medians, opponent strength, garbage time, play calling, and changing team records are not modeled by these fixtures.</p>
<p>Raw results: <a href="before.json">original model</a> · <a href="after.json">revised model</a>. Regenerate current results with <code>STARTER_SCORE_REPORT_PATH</code> set to <code>analysis/starter-score/after.json</code> while running <code>starterScoreScenarios.football.test.ts</code>, then run <code>node tools/analysis/renderStarterScoreReport.ts</code>.</p>
</main></body></html>`;
await fs.writeFile(new URL("report.html", directory), html);
console.log("Wrote analysis/starter-score/report.html");
