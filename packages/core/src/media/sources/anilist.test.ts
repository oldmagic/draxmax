import { describe, expect, it } from 'vitest';
import { aniPlain } from './anilist.ts';

describe('aniPlain', () => {
  it('turns AniList markup into plain text, leaving no tag behind', () => {
    expect(aniPlain('A <i>brave</i> hero.<br><br><br>Part two')).toBe('A brave hero.\n\nPart two');
    expect(aniPlain('<scr<b>ipt>alert(1)</script>')).not.toMatch(/[<>]/);
    expect(aniPlain(null)).toBeUndefined();
  });
});
