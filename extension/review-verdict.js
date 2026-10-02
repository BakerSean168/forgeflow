export const REVIEW_VERDICTS = Object.freeze(["BLOCK", "OK", "OK with notes"]);
const VERDICT_PREFIXES = Object.freeze(["Merge verdict: ", "- Merge verdict: "]);

export function parseReviewVerdict(report) {
  if (typeof report !== "string") {
    return { status: "invalid", reason: "REVIEW_REPORT_NOT_TEXT" };
  }

  if (report.trim().length === 0) {
    return { status: "invalid", reason: "REVIEW_REPORT_EMPTY" };
  }

  const lines = report
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const lastLine = lines.at(-1);
  if (!lastLine) {
    return { status: "invalid", reason: "REVIEW_REPORT_EMPTY" };
  }

  const prefix = VERDICT_PREFIXES.find((candidate) => lastLine.startsWith(candidate));
  if (!prefix) {
    return {
      status: "invalid",
      reason: "REVIEW_VERDICT_MISSING",
      lastLine
    };
  }

  const verdict = lastLine.slice(prefix.length);
  if (!REVIEW_VERDICTS.includes(verdict)) {
    return {
      status: "invalid",
      reason: "REVIEW_VERDICT_INVALID",
      lastLine
    };
  }

  return {
    status: verdict === "BLOCK" ? "blocked" : "clean",
    verdict
  };
}
