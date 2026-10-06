import { expect, test, vi } from "vitest";
// @ts-expect-error Node APIs are available in this opt-in test runner.
import fs from "node:fs/promises";
// @ts-expect-error Node APIs are available in this opt-in test runner.
import process from "node:process";
import { LEAGUE_DATABASE_VERSION, PHASE, PLAYER } from "../common/constants.ts";
import { POSITIONS } from "../common/constants.football.ts";
import { last } from "../common/utils.ts";
import { defaultGameAttributes } from "../common/defaultGameAttributes.ts";
import type { Player, TeamSeason } from "../common/types.ts";
import type { Position } from "../common/types.football.ts";
import { game, league } from "../worker/core/index.ts";
import * as depthSorter from "../worker/core/team/rosterAutoSort.football.ts";
import * as draftSelector from "../worker/core/draft/selectPlayer.ts";
import GameSim from "../worker/core/GameSim.football/index.ts";
import { startAutoPlay } from "../worker/core/league/autoPlay.ts";
import {
	FOOTBALL_STARTERS,
	getStarterContext,
	getStarterScore,
	gradeFootballPerformance,
	prepareFootballRoster,
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
		const draftDecisions: unknown[] = [];
		const selectPlayer = draftSelector.default;
		const observeDraft = vi
			.spyOn(draftSelector, "default")
			.mockImplementation(async (dp, pid) => {
				if (
					process.env.STARTER_SCORE_RECRUITMENT &&
					dp.round === 1 &&
					g.get("phase") === PHASE.DRAFT
				) {
					const ctx = await getStarterContext(dp.tid);
					const roster = await idb.cache.players.indexGetAll(
						"playersByTid",
						dp.tid,
					);
					const available = (
						await idb.cache.players.indexGetAll(
							"playersByTid",
							PLAYER.UNDRAFTED,
						)
					).filter((p) => p.draft.year === ctx.season);
					const fit = prepareFootballRoster(roster, ctx);
					const candidates = available
						.map((p) => {
							const pos = last(p.ratings).pos as Position;
							return {
								pid: p.pid,
								pos,
								ovr: last(p.ratings).ovr,
								pot: last(p.ratings).pot,
								marketValue: p.value,
								score: getStarterScore(p, pos, ctx),
								fit: fit(p),
							};
						})
						.sort((a, b) => b.fit.draftValue - a.fit.draftValue);
					draftDecisions.push(
						structuredClone({
							season: ctx.season,
							tid: dp.tid,
							pick: dp.pick,
							pid,
							strategy: ctx.strategy,
							record: [ctx.won, ctx.lost, ctx.tied],
							candidates,
							roster: roster.map((p) => {
								const pos = last(p.ratings).pos as Position;
								return {
									pid: p.pid,
									pos,
									age: ctx.season - p.born.year,
									score: getStarterScore(p, pos, ctx),
									contract: p.contract,
									draft: p.draft,
								};
							}),
						}),
					);
				}
				await selectPlayer(dp, pid);
				observeDraft.mockClear();
			});
		// Observe the scores BEFORE sorting transfers continuity to a new starter.
		const decisions = new Map<number, unknown>();
		const decisionGames = new Map<number, number>();
		let staleDecisions = 0;
		const finalOpeningTeams = new Set<number>();
		const autoSort = depthSorter.default;
		const observeSort = vi
			.spyOn(depthSorter, "default")
			.mockImplementation(async (...args) => {
				if (
					g.get("phase") === PHASE.REGULAR_SEASON ||
					g.get("phase") === PHASE.AFTER_TRADE_DEADLINE
				) {
					const ctx = await getStarterContext(args[0]);
					decisionGames.set(args[0], ctx.won + ctx.lost + ctx.tied);
					const roster = await idb.cache.players.indexGetAll(
						"playersByTid",
						args[0],
					);
					decisions.set(
						args[0],
						Object.fromEntries(
							POSITIONS.map((pos) => {
								const ranked = roster
									.map((p) => ({ p, score: getStarterScore(p, pos, ctx) }))
									.sort((a, b) => b.score.score - a.score.score);
								return [
									pos,
									{
										before: ctx.depth[pos]?.slice(0, FOOTBALL_STARTERS[pos]),
										candidates: ranked
											.filter(
												({ p }, index) =>
													last(p.ratings).pos === pos ||
													index < FOOTBALL_STARTERS[pos] + 2 ||
													ctx.depth[pos]
														?.slice(0, FOOTBALL_STARTERS[pos])
														.includes(p.pid),
											)
											.map(({ p, score }) => {
												const row = p.stats.findLast(
													(row) =>
														row.season === ctx.season &&
														!row.playoffs &&
														row.tid === p.tid,
												);
												return {
													pid: p.pid,
													pos: last(p.ratings).pos,
													age: ctx.season - p.born.year,
													ovr: last(p.ratings).ovr,
													pot: last(p.ratings).pot,
													unavailable: p.injury.gamesRemaining > 0,
													score,
													grade: row
														? gradeFootballPerformance(
																row as unknown as Record<string, number>,
																pos,
																ctx.fieldLength,
															)
														: undefined,
													stats: row
														? Object.fromEntries(
																Object.entries(row).filter(
																	([, value]) =>
																		typeof value === "number" && value !== 0,
																),
															)
														: {},
												};
											}),
									},
								];
							}),
						),
					);
				}
				await autoSort(...args);
				observeSort.mockClear();
			});
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
						unavailable: t.player.filter((p) => p.injured).map((p) => p.id),
					};
					if (ctx.season === 2026 + years) {
						finalOpeningTeams.add(t.id);
					}
					if (
						g.get("phase") !== PHASE.PLAYOFFS &&
						decisionGames.get(t.id) !== ctx.won + ctx.lost + ctx.tied
					) {
						staleDecisions++;
					}
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
						decisions: decisions.get(t.id),
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
			if (process.env.STARTER_SCORE_RECRUITMENT) {
				// A preseason depth list can change before the first actual start.
				// Observe the final drafted cohort too, allowing an opening bye.
				for (let week = 0; week < 3 && finalOpeningTeams.size < 32; week++) {
					await game.play(1, {});
				}
				expect(finalOpeningTeams.size).toBe(32);
			}
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
				draftDecisions,
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
			expect(decisions.size).toBe(32);
			expect(staleDecisions).toBe(0);
			if (process.env.STARTER_SCORE_RECRUITMENT) {
				expect(draftDecisions).toHaveLength(years * 32);
			}
		} finally {
			observeDraft.mockRestore();
			observeSort.mockRestore();
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
