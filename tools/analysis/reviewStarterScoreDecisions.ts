import fs from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";

// Review flags are deliberately separate from the production selection rule.
// A poor starter is not automatically a mistake when all alternatives are worse.
type Candidate = {
	pid: number;
	pos: string;
	age: number;
	ovr: number;
	pot: number;
	score: Record<string, number> & {
		score: number;
		ability: number;
		performance: number;
		continuity: number;
	};
	grade?: { score: number; samples: number };
	stats: Record<string, number>;
};
type Game = {
	season: number;
	tid: number;
	gid: number;
	playoffs: boolean;
	record: number[];
	unavailable: number[];
	roles: Record<string, { pid: number }[]>;
	decisions: Record<string, { before: number[]; candidates: Candidate[] }>;
};
type Report = {
	seed: number;
	years: number;
	games: Game[];
	checkpoints: { teams: { tid: number; name: string }[] }[];
	players: {
		pid: number;
		draft: { year: number; tid: number; round: number };
		ratings: { pos: string }[];
	}[];
};
type Review = {
	seed: number;
	season: number;
	team: string;
	tid: number;
	week: number;
	role: string;
	record: number[];
	incumbent: Candidate;
	alternative: Candidate;
	gap: number;
};
const read = async (file: string) => {
	const bytes = await fs.readFile(file);
	return JSON.parse(
		(file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString(),
	);
};
const directory = "analysis/starter-score";
const reports: Report[] = await Promise.all(process.argv.slice(2).map(read));
if (!reports.length) {
	throw new Error("Pass refined league JSON paths");
}
const switches: Review[] = [];
const held: Review[] = [];
const breakoutHolds: Review[] = [];
const selectionErrors: Review[] = [];
const duplicateDrafts: unknown[] = [];
const roles: Record<
	string,
	{
		decisions: number;
		healthySwitches: number;
		poorHolds: number;
		positiveReserveHolds: number;
	}
> = {};
for (const report of reports) {
	const histories = new Map<string, Game[]>();
	for (const game of report.games.filter((g) => !g.playoffs)) {
		const key = `${game.season}/${game.tid}`;
		if (!histories.has(key)) {
			histories.set(key, []);
		}
		histories.get(key)!.push(game);
	}
	for (const games of histories.values()) {
		for (const [index, game] of games.entries()) {
			if (!game.decisions) {
				throw new Error(
					`Missing pre-decision observation ${game.gid}/${game.tid}`,
				);
			}
			for (const [role, decision] of Object.entries(game.decisions)) {
				const summary = (roles[role] ??= {
					decisions: 0,
					healthySwitches: 0,
					poorHolds: 0,
					positiveReserveHolds: 0,
				});
				summary.decisions++;
				const members = game.roles[role]!.map((p) => p.pid);
				const available = decision.candidates.filter(
					(p) => !game.unavailable.includes(p.pid),
				);
				const selected = available.filter((p) => members.includes(p.pid));
				const reserve = available.find((p) => !members.includes(p.pid));
				const incumbent = selected.at(-1);
				const row = (inc: Candidate, alt: Candidate): Review => ({
					seed: report.seed,
					season: game.season,
					tid: game.tid,
					team: report.checkpoints[0]!.teams.find((t) => t.tid === game.tid)!
						.name,
					week: index + 1,
					role,
					record: game.record,
					incumbent: inc,
					alternative: alt,
					gap: alt.score.score - inc.score.score,
				});
				if (
					incumbent &&
					reserve &&
					reserve.score.score > incumbent.score.score + 0.01
				) {
					selectionErrors.push(row(incumbent, reserve));
				}
				if (
					incumbent &&
					reserve &&
					incumbent.grade &&
					reserve.grade &&
					incumbent.grade.samples >= 4 &&
					reserve.grade.samples >= 4 &&
					reserve.grade.score >= 4 &&
					reserve.score.performance >= 3 &&
					reserve.grade.score - incumbent.grade.score >= 5 &&
					reserve.score.ability >= incumbent.score.ability - 8
				) {
					breakoutHolds.push(row(incumbent, reserve));
				}
				// Sustained poor measured production, with a healthy reserve within
				// five ability points. Includes low-evidence reserves for inspection,
				// but counts reserves with positive measured evidence separately.
				if (
					incumbent &&
					reserve &&
					incumbent.grade &&
					incumbent.grade.samples >= 4 &&
					incumbent.grade.score <= -4 &&
					incumbent.score.performance <= -3 &&
					reserve.score.ability >= incumbent.score.ability - 5 &&
					(role === "KR" ||
						role === "PR" ||
						(incumbent.pos === role && reserve.pos === role))
				) {
					held.push(row(incumbent, reserve));
					summary.poorHolds++;
					if (
						reserve.grade &&
						reserve.grade.samples >= 1 &&
						reserve.grade.score > 0
					) {
						summary.positiveReserveHolds++;
					}
				}
				const previous = games[index - 1];
				if (!previous) {
					continue;
				}
				const oldMembers = previous.roles[role]!.map((p) => p.pid);
				const outgoing = available.filter(
					(p) =>
						oldMembers.includes(p.pid) &&
						!members.includes(p.pid) &&
						!previous.unavailable.includes(p.pid),
				);
				const incoming = selected.filter(
					(p) =>
						!oldMembers.includes(p.pid) &&
						!previous.unavailable.includes(p.pid) &&
						Object.values(previous.decisions).some((oldRole) =>
							oldRole.candidates.some((old) => old.pid === p.pid),
						),
				);
				for (let i = 0; i < Math.min(outgoing.length, incoming.length); i++) {
					switches.push(row(outgoing[i]!, incoming[i]!));
					summary.healthySwitches++;
				}
			}
		}
	}
	const drafts = new Map<string, number[]>();
	for (const p of report.players) {
		if (
			p.draft.year < 2026 ||
			p.draft.year >= 2026 + report.years ||
			p.draft.round < 1 ||
			p.ratings.at(-1)?.pos !== "QB"
		) {
			continue;
		}
		const key = `${p.draft.year}/${p.draft.tid}`;
		if (!drafts.has(key)) {
			drafts.set(key, []);
		}
		drafts.get(key)!.push(p.pid);
	}
	for (const [key, pids] of drafts) {
		if (pids.length > 1) {
			duplicateDrafts.push({ seed: report.seed, key, pids });
		}
	}
}
const holdGroups = new Map<string, Review[]>();
for (const row of held) {
	const key = `${row.seed}/${row.season}/${row.tid}/${row.role}/${row.incumbent.pid}/${row.alternative.pid}`;
	if (!holdGroups.has(key)) {
		holdGroups.set(key, []);
	}
	holdGroups.get(key)!.push(row);
}
const cases = [...holdGroups.values()]
	.map((rows) => ({
		...rows.at(-1)!,
		firstFlagWeek: rows[0]!.week,
		flaggedWeeks: rows.map((r) => r.week),
		continuityDecisive:
			rows.at(-1)!.gap + rows.at(-1)!.incumbent.score.continuity > 0,
	}))
	.sort((a, b) => b.flaggedWeeks.length - a.flaggedWeeks.length);
const output = {
	roles,
	switches,
	cases,
	breakoutHolds,
	selectionErrors,
	duplicateDrafts,
};
await fs.writeFile(
	`${directory}/league-refinement-decisions.json`,
	JSON.stringify(output),
);
await fs.writeFile(
	`${directory}/league-refinement-decisions.json.gz`,
	gzipSync(JSON.stringify(output)),
);
console.log(
	JSON.stringify(
		{
			roles,
			cases: cases.length,
			breakoutHolds: breakoutHolds.length,
			selectionErrors: selectionErrors.length,
			duplicateDrafts,
		},
		null,
		2,
	),
);
const esc = (v: unknown) =>
	String(v ?? "—")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll('"', "&quot;");
const table = (headers: string[], rows: unknown[][]) =>
	`<div class="table"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const player = (p: Candidate) =>
	`#${p.pid}, age ${p.age}, ${p.ovr}/${p.pot}; score ${p.score.score.toFixed(1)}, performance ${p.score.performance.toFixed(1)}, ability ${p.score.ability}`;
const details = (r: Review) =>
	`<p>Incumbent ${esc(player(r.incumbent))}<br>Alternative ${esc(player(r.alternative))}<br>Alternative minus incumbent, before the decision: ${r.gap.toFixed(2)} points.</p><details><summary>Full score components, opportunity counts and statistics</summary><pre>${esc(JSON.stringify({ incumbent: r.incumbent, alternative: r.alternative }, null, 2))}</pre></details>`;
const baseline = await read(`${directory}/league-summary.json.gz`);
const revised = await read(`${directory}/league-refined-summary.json.gz`);
const afterOneGame = (summary: {
	teamRows: { changes: { kind: string; game: number }[] }[];
}) =>
	summary.teamRows.reduce(
		(total, row) =>
			total +
			row.changes.filter(
				(change) => change.kind === "healthy competition" && change.game === 2,
			).length,
		0,
	);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Starter Score refinement audit</title><style>:root{font:16px/1.5 system-ui;color-scheme:light dark}body{margin:0}main{max-width:1120px;margin:auto;padding:32px 24px 80px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:10px;text-align:left;border-bottom:1px solid #8885;vertical-align:top}.table{overflow:auto}details{padding:12px 0;border-top:1px solid #8885}summary{cursor:pointer;font-weight:600}pre{font-size:12px;overflow:auto;max-height:500px}a{color:light-dark(#155eb0,#8bc3ff)}</style></head><body><main><h1>Starter Score: decisions under review</h1><p>Two generated 32-team leagues, three seasons each. Original and revised runs use the same starting seeds. AI decisions change subsequent random draws, so later games and players are not matched experimental pairs. Review flags identify decisions worth inspecting; they are not automatically errors.</p><p><a href="refinement-findings.md">Interpretation and concrete examples</a> · <a href="league-report.html">Original league audit</a> · <a href="league-refined-report.html">Revised league audit</a></p>
${table(
	["Measure", "Original", "Revised"],
	[
		[
			"Healthy QB changes",
			baseline.aggregate.healthyChanges,
			revised.aggregate.healthyChanges,
		],
		[
			"Healthy QB changes after only one game",
			afterOneGame(baseline),
			afterOneGame(revised),
		],
		[
			"One-game healthy reversals",
			baseline.aggregate.rapidReversals,
			revised.aggregate.rapidReversals,
		],
		[
			"First-round QBs",
			baseline.aggregate.firstRoundPositions.QB,
			revised.aggregate.firstRoundPositions.QB,
		],
		[
			"MVPs starting at next opener",
			baseline.mvpRows.filter(
				(r: { stillStarting: boolean }) => r.stillStarting,
			).length,
			revised.mvpRows.filter((r: { stillStarting: boolean }) => r.stillStarting)
				.length,
		],
	],
)}
<h2>Every role, including decisions to keep a struggling starter</h2><p>A hold is flagged when the weakest healthy starter has at least four full-game equivalents of opportunities, raw performance grade ≤ −4, a performance contribution ≤ −3, and a healthy reserve within five ability points. A reserve with little or no evidence is not assumed better. Quiet defensive backs cannot be assessed as poor coverage from the game's recorded box scores; the screen does not flag them. Multi-player positions compare the weakest starter with the best available reserve, not WR1 against WR2.</p>
${table(
	[
		"Role",
		"Team-game decisions",
		"Healthy slot replacements",
		"Flagged holds (weeks)",
		"Of those, reserve has positive evidence",
	],
	Object.entries(roles).map(([role, r]) => [
		role,
		r.decisions,
		r.healthySwitches,
		r.poorHolds,
		r.positiveReserveHolds,
	]),
)}
<p>Selection consistency errors (an available reserve has a higher pre-decision score than a selected starter): ${selectionErrors.length}. Multiple-QB team-drafts: ${duplicateDrafts.length}. These checks do not establish that the score itself is correct.</p>
<p><label>Filter detailed cases by role: <select id="role-filter"><option value="">All roles</option>${Object.keys(
	roles,
)
	.map((role) => `<option>${esc(role)}</option>`)
	.join("")}</select></label></p>
<h2>Possible missed changes: ${cases.length} player-pair cases</h2>${cases.map((r) => `<details data-role="${esc(r.role)}"><summary>${esc(r.role)} · ${esc(r.team)} ${r.season} · seed ${r.seed} · flagged weeks ${r.flaggedWeeks.join(", ")}</summary><p>Continuity alone prevents promotion at last flag: ${r.continuityDecisive ? "yes" : "no"}. Record ${r.record.join("–")}.</p>${details(r)}</details>`).join("")}
<h2>Healthy depth-slot changes: ${switches.length}</h2><p>The scores below are captured before the depth sort; continuity has not yet transferred to the new starter. Injury-associated or newly acquired players are excluded. This counts depth membership, distinct from an injured starter's replacement on the field.</p>${switches.map((r) => `<details data-role="${esc(r.role)}"><summary>${esc(r.role)} · ${esc(r.team)} ${r.season} · game ${r.week} · seed ${r.seed}</summary>${details(r)}</details>`).join("")}
<h2>Productive reserves held out: ${breakoutHolds.length} weekly flags</h2><p>Both players have at least four game-equivalents of evidence; the reserve has grade ≥ 4, a performance contribution ≥ 3, a grade at least five points better than the incumbent, and ability within eight points. These flags also include cases where the starter is playing adequately.</p>${breakoutHolds.map((r) => `<details data-role="${esc(r.role)}"><summary>${esc(r.role)} · ${esc(r.team)} ${r.season} · game ${r.week} · seed ${r.seed}</summary>${details(r)}</details>`).join("")}
<p><a href="league-refinement-decisions.json.gz">All review evidence (gzip JSON)</a></p></main><script>document.getElementById("role-filter").addEventListener("change", function(){document.querySelectorAll("details[data-role]").forEach(el=>{el.hidden=!!this.value && el.dataset.role!==this.value;});});</script></body></html>`;
await fs.writeFile(`${directory}/refinement-report.html`, html);
