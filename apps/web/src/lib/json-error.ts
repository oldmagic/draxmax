/**
 * Where JSON text first goes wrong: "Line L, column C: problem" and the offset. Browsers' own messages
 * don't say where (Chrome quotes a snippet), which is useless in a long document.
 */
export function locateJsonError(text: string): { message: string; index: number } {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const fail = (what: string): never => {
    throw new Error(what);
  };
  const expect = (ch: string) => (text[i] === ch ? i++ : fail(`expected “${ch}”`));
  const str = () => {
    expect('"');
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') fail('line break inside a string');
      i += text[i] === '\\' ? 2 : 1;
    }
    expect('"');
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail(text[i] === '}' ? 'trailing comma' : 'expected a "key"');
        str();
        ws();
        expect(':');
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return void i++;
        else fail('expected “,” or “}”');
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (;;) {
        ws();
        if (text[i] === ']') fail('trailing comma');
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return void i++;
        else fail('expected “,” or “]”');
      }
    }
    if (c === '"') return str();
    const lit = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(i, i + 40));
    if (lit) return void (i += lit[0].length);
    fail(c === undefined ? 'unexpected end' : `unexpected “${c}”`);
  };
  try {
    value();
    ws();
    if (i < text.length) fail('unexpected text after the end');
    return { message: 'Invalid JSON', index: 0 };
  } catch (e) {
    const before = text.slice(0, i).split('\n');
    return {
      message: `Line ${before.length}, column ${before.at(-1)!.length + 1}: ${(e as Error).message}`,
      index: i,
    };
  }
}
