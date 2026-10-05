import { idb } from "../../db/index.ts";
import genDepth from "./genDepth.football.ts";
import type { Position } from "../../../common/types.football.ts";
import { POSITIONS } from "../../../common/constants.football.ts";
import { g, local } from "../../util/index.ts";
import { getStarterContext, getStarterScore } from "./starterScore.football.ts";

const rosterAutoSort = async (
	tid: number,
	onlyNewPlayers?: boolean,
	pos?: Position,
) => {
	const t = await idb.cache.teams.get(tid);
	if (!t) {
		throw new Error("Invalid tid");
	}

	const playersFromCache = await idb.cache.players.indexGetAll(
		"playersByTid",
		tid,
	);
	const useStarterScores =
		!onlyNewPlayers &&
		!local.exhibitionGamePlayers &&
		(!g.get("userTids").includes(tid) ||
			g.get("spectator") ||
			!!local.autoPlayUntil);
	// Read the incumbent depth chart before genDepth replaces it.
	const context = useStarterScores ? await getStarterContext(tid) : undefined;

	t.depth = await genDepth(
		playersFromCache,
		t.depth as {
			QB: number[];
			RB: number[];
			WR: number[];
			TE: number[];
			OL: number[];
			DL: number[];
			LB: number[];
			CB: number[];
			S: number[];
			K: number[];
			P: number[];
			KR: number[];
			PR: number[];
		},
		onlyNewPlayers,
		pos,
	);
	if (context) {
		for (const role of pos ? [pos] : POSITIONS) {
			const previousOrder = new Map(
				(context.depth[role] ?? []).map((pid, index) => [pid, index]),
			);
			const ranked = playersFromCache.map((p) => ({
				p,
				score: getStarterScore(p, role, context).score,
			}));
			// Equal scores (especially two players capped at 100) are not an
			// improvement. Keep the incumbent rather than favoring a newer pid.
			ranked.sort(
				(a, b) =>
					b.score - a.score ||
					(previousOrder.get(a.p.pid) ?? Number.MAX_SAFE_INTEGER) -
						(previousOrder.get(b.p.pid) ?? Number.MAX_SAFE_INTEGER) ||
					b.p.pid - a.p.pid,
			);
			(t.depth as Record<Position, number[]>)[role] = ranked.map(
				(row) => row.p.pid,
			);
		}
	}

	await idb.cache.teams.put(t);
};

export default rosterAutoSort;
