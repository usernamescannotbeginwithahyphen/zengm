// Length is measured between goal lines. End zones remain 10 yards deep.
export const getFootballField = (fieldLength: number) => ({
	length: fieldLength,
	kickoff: Math.round(fieldLength * 0.35),
	safetyKickoff: Math.round(fieldLength * 0.2),
	touchback: Math.round(fieldLength * 0.2),
	extraPoint: fieldLength - 15,
	twoPointConversion: fieldLength - 2,
});
