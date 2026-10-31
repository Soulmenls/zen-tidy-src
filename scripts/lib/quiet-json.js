// JSON.parse whose error never quotes the input. V8's SyntaxError message includes the text around
// the bad character, which in a session or tabs file is a title or a URL, and the CLIs print error
// messages. Only the position (when V8 gives one) survives; the original error is not kept as cause.
export function parseJsonQuietly(text, label = "input") {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const position = /\bposition (\d+)/.exec(String(error.message))?.[1];
    throw new SyntaxError(`${label} is not valid JSON${position ? ` (position ${position})` : ""}`);
  }
}
