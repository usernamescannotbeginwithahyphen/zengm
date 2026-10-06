import { expect, test, vi } from "vitest";
// @ts-expect-error Node APIs are available in this opt-in test runner.
import fs from "node:fs/promises";
// @ts-expect-error Node APIs are available in this opt-in test runner.
import process from "node:process";
import { LEAGUE_DATABASE_VERSION, PHASE } from "../common/constants.ts";
import { POSITIONS } from "../common/constants.football.ts";
import { last } from "../common/utils.ts";
import { defaultGameAttributes } from "../common/defaultGameAttributes.ts";
import type { Player, TeamSeason } from "../common/types.ts";
import { league } from "../worker/core/index.ts";
import GameSim from "../worker/core/GameSim.football/index.ts";
import { startAutoPlay } from "../worker/core/league/autoPlay.ts";
import {
	FOOTBALL_STARTERS,
	getStarterContext,
	getStarterScore,
	type StarterContext,
} from "../worker/core/team/starterScore.football.ts";
import { idb } from "../worker/db/index.ts";
import { g, helpers } from "../worker/util/index.ts";
import { getDefaultSettings } from "../worker/views/newLeague.ts";

// Opt-in integration experiment. No ratings, stats, injuries, acquisitions,
// schedules, or simulation results are mocked. IndexedDB is in memory and UI
// notifications use the repository's ordinary test environment.
const enabled = !!process.env.STARTER_SCORE_LEAGUE_REPORT;
const statKeys = [
	"gp",
	"gs",
	"pss",
	"pssCmp",
	"pssYds",
	"pssTD",
	"pssInt",
	"pssSk",
	"pssSkYds",
	"rus",
	"rusYds",
	"rusTD",
	"fmbLost",
];
const stats = (row: Record<string, unknown> | undefined) =>
	Object.fromEntries(statKeys.map((key) => [key, row?.[key] ?? 0]));
const profile = (p: Player, ctx: StarterContext) => ({
	pid: p.pid,
	name: `${p.firstName} ${p.lastName}`,
	tid: p.tid,
	pos: last(p.ratings).pos,
	age: ctx.season - p.born.year,
	ovr: last(p.ratings).ovr,
	pot: last(p.ratings).pot,
	fuzz: last(p.ratings).fuzz,
	contract: p.contract,
	draft: p.draft,
	injury: p.injury,
	score: getStarterScore(p, "QB", ctx),
	stats: stats(
		p.stats.findLast(
			(row) => row.season === ctx.season && !row.playoffs && row.tid === p.tid,
		),
	),
	previousStats: stats(
		p.stats.findLast((row) => row.season === ctx.season - 1 && !row.playoffs),
	),
});

test.skipIf(!enabled)(
	"generated football leagues run through complete seasons",
	async () => {
		// @ts-expect-error The package omits this declaration from its exports map.
		await import("fake-indexeddb/auto");
		const seed = Number(process.env.STARTER_SCORE_SEED ?? 20261005);
		const years = Number(process.env.STARTER_SCORE_YEARS ?? 3);
		const fieldLength = Number(process.env.STARTER_SCORE_FIELD_LENGTH ?? 100);
		let randomState = seed >>> 0;
		// A spy would retain millions of random calls across full seasons.
		const originalRandom = Math.random;
		Math.random = () => {
			randomState = (randomState + 0x6d2b79f5) >>> 0;
			let value = Math.imul(
				randomState ^ (randomState >>> 15),
				1 | randomState,
			);
			value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
			return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
		};
		const games: unknown[] = [];
		const checkpoints: unknown[] = [];
		const gameRun = GameSim.prototype.run;
		let gameCount = 0;
		const observe = vi
			.spyOn(GameSim.prototype, "run")
			.mockImplementation(function (this: GameSim) {
				if (this.allStarGame) {
					return gameRun.call(this);
				}
				const records = this.team.map((t) => {
					const team = idb.cache._data.teams[t.id]!;
					const ts = (
						Object.values(idb.cache._data.teamSeasons) as TeamSeason[]
					).find((row) => row.tid === t.id && row.season === g.get("season"));
					const ctx: StarterContext = {
						tid: t.id,
						season: g.get("season"),
						strategy: team.strategy,
						won: ts?.won ?? 0,
						lost: ts?.lost ?? 0,
						tied: ts?.tied ?? 0,
						numGames: g.get("numGames"),
						salaryCap: g.get("salaryCap"),
						fieldLength: g.get("fieldLength"),
						depth: team.depth,
					};
					const qbs = t.player
						.filter((p) => p.pos === "QB")
						.map((p) => ({
							...profile(idb.cache._data.players[p.id]!, ctx),
							unavailable: p.injured,
						}));
					// Both opening units have already had gs recorded by the
					// constructor. playersOnField itself now contains only the most
					// recently initialized offense/defense, so do not read it here.
					const starter = t.depth.QB.find((p) => (p.stat.gs ?? 0) > 0);
					return structuredClone({
						season: ctx.season,
						playoffs: g.get("phase") === PHASE.PLAYOFFS,
						gid: this.id,
						day: this.day,
						tid: t.id,
						record: [ctx.won, ctx.lost, ctx.tied],
						strategy: ctx.strategy,
						starter: starter?.id,
						depthQB: team.depth.QB.slice(0, 3),
						qbs,
						roles: Object.fromEntries(
							POSITIONS.map((pos) => [
								pos,
								t.depth[pos]
									.slice(0, FOOTBALL_STARTERS[pos])
									.map((p) => ({ pid: p.id, unavailable: p.injured })),
							]),
						),
						unavailable: t.player.filter((p) => p.injured).map((p) => p.id),
					});
				});
				const result = gameRun.call(this);
				for (let i = 0; i < records.length; i++) {
					games.push({
						...records[i],
						points: result.team[i]!.stat.pts,
						qbGameStats: result.team[i]!.player.filter((p) =>
							records[i]!.qbs.some((qb) => qb.pid === p.id),
						).map((p) => ({ pid: p.id, ...stats(p.stat) })),
					});
				}
				gameCount++;
				observe.mockClear();
				if (gameCount % 100 === 0) {
					console.log(
						`League ${seed}: ${gameCount} games, season ${g.get("season")}`,
					);
				}
				return result;
			});
		const snapshot = async (label: string) => {
			const teams = await idb.cache.teams.getAll();
			const players = await idb.cache.players.getAll();
			const rosters = [];
			for (const team of teams.filter((t) => !t.disabled)) {
				const ctx = await getStarterContext(team.tid);
				rosters.push({
					tid: team.tid,
					name: `${team.region} ${team.name}`,
					strategy: team.strategy,
					record: [ctx.won, ctx.lost, ctx.tied],
					depth: team.depth,
					qbs: players
						.filter((p) => p.tid === team.tid && last(p.ratings).pos === "QB")
						.map((p) => profile(p, ctx)),
					rosterCounts: Object.fromEntries(
						POSITIONS.map((pos) => [
							pos,
							players.filter(
								(p) => p.tid === team.tid && last(p.ratings).pos === pos,
							).length,
						]),
					),
				});
			}
			checkpoints.push(
				structuredClone({
					label,
					season: g.get("season"),
					phase: g.get("phase"),
					teams: rosters,
				}),
			);
			console.log(`League ${seed}: ${g.get("season")} ${label}`);
		};
		try {
			await league.createStream(
				{},
				{
					confs: last(defaultGameAttributes.confs).value,
					divs: last(defaultGameAttributes.divs).value,
					fromFile: {
						gameAttributes: undefined,
						hasRookieContracts: true,
						maxGid: undefined,
						startingSeason: undefined,
						teams: undefined,
						version: LEAGUE_DATABASE_VERSION,
					},
					getLeagueOptions: undefined,
					keptKeys: new Set(),
					lid: seed,
					name: `Starter Score audit ${seed}`,
					setLeagueCreationStatus: (message) =>
						console.log(`Creating ${seed}: ${message}`),
					settings: { ...getDefaultSettings(), fieldLength },
					shuffleRosters: false,
					startingSeasonFromInput: "2026",
					teamsFromInput: helpers.addPopRank(helpers.getTeamsDefault()),
					tid: 0,
				},
			);
			await league.loadGameAttributes();
			await league.setGameAttributes({ spectator: true });
			await snapshot("generated");
			for (let year = 2026; year < 2026 + years; year++) {
				if (g.get("phase") !== PHASE.REGULAR_SEASON) {
					await startAutoPlay(year, PHASE.REGULAR_SEASON, {});
				}
				await snapshot("opening");
				await startAutoPlay(year, PHASE.DRAFT_LOTTERY, {});
				await snapshot("season-end");
				await startAutoPlay(year, PHASE.AFTER_DRAFT, {});
				await snapshot("after-draft");
				await startAutoPlay(year + 1, PHASE.PRESEASON, {});
				await snapshot("next-preseason");
			}
			await startAutoPlay(2026 + years, PHASE.REGULAR_SEASON, {});
			await snapshot("final-opening");
			await idb.cache.flush();
			const players = await idb.league.getAll("players");
			const awards = await idb.league.getAll("awards");
			const events = (await idb.league.getAll("events")).filter((e) =>
				["draft", "freeAgent", "reSigned", "release", "trade"].includes(e.type),
			);
			const report = {
				seed,
				years,
				fieldLength,
				methodology:
					"Production random league creation and full autoplay, all teams AI-controlled. Default settings except spectator and specified field length. Seeded Math.random; in-memory IndexedDB; UI notifications disabled by standard test environment. Observers delegate to unmodified game simulation. No ratings, player outcomes or transactions injected. Pregame depth-chart membership is distinct from actual QB starts and injury availability.",
				gameCount,
				checkpoints,
				games,
				awards,
				events,
				players: players.map((p) => ({
					pid: p.pid,
					name: `${p.firstName} ${p.lastName}`,
					tid: p.tid,
					born: p.born,
					draft: p.draft,
					contract: p.contract,
					ratings: p.ratings.map((r) => ({
						season: r.season,
						pos: r.pos,
						ovr: r.ovr,
						pot: r.pot,
					})),
					stats: p.stats,
					awards: p.awards,
					transactions: p.transactions,
				})),
			};
			await fs.writeFile(
				process.env.STARTER_SCORE_LEAGUE_REPORT,
				JSON.stringify(report, (_key, value) =>
					typeof value === "number" && !Number.isInteger(value)
						? Math.round(value * 1000) / 1000
						: value,
				),
			);
			expect(g.get("season")).toBe(2026 + years);
			expect(gameCount).toBeGreaterThan(years * 250);
			expect(games).toHaveLength(gameCount * 2);
		} finally {
			observe.mockRestore();
			Math.random = originalRandom;
			if (g.get("lid") === seed) {
				await league.remove(seed);
			}
			await idb.meta.close();
		}
	},
	1_800_000,
);
