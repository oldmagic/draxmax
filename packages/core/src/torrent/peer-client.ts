/** Azureus-style peer-id prefixes (`-XX1234-`) of common clients. */
const CLIENTS: Record<string, string> = {
  qB: 'qBittorrent',
  TR: 'Transmission',
  UT: 'µTorrent',
  UM: 'µTorrent Mac',
  UW: 'µTorrent Web',
  BT: 'BitTorrent',
  DE: 'Deluge',
  lt: 'libtorrent',
  LT: 'libtorrent',
  AZ: 'Vuze',
  WW: 'WebTorrent',
  WD: 'WebTorrent Desktop',
  BI: 'BiglyBT',
  TX: 'Tixati',
  FD: 'Free Download Manager',
  RT: 'rTorrent',
  KT: 'KTorrent',
  PI: 'PicoTorrent',
  BC: 'BitComet',
  XL: 'Xunlei',
};

/** Best-effort client name from a hex peer id. */
export function clientFromPeerId(peerIdHex: string | undefined): string {
  if (!peerIdHex || peerIdHex.length < 16) return 'Unknown';
  const ascii = Buffer.from(peerIdHex.slice(0, 16), 'hex').toString('latin1');
  const m = /^-([A-Za-z]{2})([0-9A-Za-z]{4})-/.exec(ascii);
  if (!m) return 'Unknown';
  const name = CLIENTS[m[1]!] ?? m[1]!;
  const v = m[2]!.replace(/^(\w)(\w)(\w)(\w)$/, (_s, a, b, c) => `${a}.${b}.${c}`);
  return `${name} ${v}`;
}
