/**
 * Curated Cyrillic/Greek (and a few Latin) look-alikes → ASCII, selected from the Unicode TR39 confusables data
 * (Unicode License v3). Keys are written as escapes so they cannot be mistaken for ASCII in review. Polish letters
 * are never folded. Folding is applied only inside long alphanumeric tokens that mix ASCII with these letters.
 */
export const HOMOGLYPHS: ReadonlyMap<string, string> = new Map([
  // Cyrillic small letters
  ['\u0430', 'a'], // a
  ['\u0431', '6'], // be
  ['\u0435', 'e'], // ie
  ['\u043E', 'o'], // o
  ['\u0440', 'p'], // er
  ['\u0441', 'c'], // es
  ['\u0443', 'y'], // u
  ['\u0445', 'x'], // ha
  ['\u0455', 's'], // dze
  ['\u0456', 'i'], // byelorussian-ukrainian i
  ['\u0458', 'j'], // je
  ['\u0475', 'v'], // izhitsa
  ['\u04BB', 'h'], // shha
  ['\u04CF', 'l'], // palochka
  ['\u0501', 'd'], // komi de
  ['\u051B', 'q'], // qa
  ['\u051D', 'w'], // we
  // Cyrillic capital letters
  ['\u0405', 'S'], // dze
  ['\u0406', 'I'], // byelorussian-ukrainian i
  ['\u0408', 'J'], // je
  ['\u0410', 'A'], // a
  ['\u0412', 'B'], // ve
  ['\u0415', 'E'], // ie
  ['\u0417', '3'], // ze
  ['\u041A', 'K'], // ka
  ['\u041C', 'M'], // em
  ['\u041D', 'H'], // en
  ['\u041E', 'O'], // o
  ['\u0420', 'P'], // er
  ['\u0421', 'C'], // es
  ['\u0422', 'T'], // te
  ['\u0425', 'X'], // ha
  ['\u0474', 'V'], // izhitsa
  ['\u04AE', 'Y'], // straight u
  ['\u04C0', 'I'], // palochka
  ['\u051A', 'Q'], // qa
  ['\u051C', 'W'], // we
  // Greek small letters
  ['\u03B1', 'a'], // alpha
  ['\u03B3', 'y'], // gamma
  ['\u03B9', 'i'], // iota
  ['\u03BD', 'v'], // nu
  ['\u03BF', 'o'], // omicron
  ['\u03C1', 'p'], // rho
  ['\u03C5', 'u'], // upsilon
  ['\u03F2', 'c'], // lunate sigma
  ['\u03F3', 'j'], // yot
  // Greek capital letters
  ['\u037F', 'J'], // yot
  ['\u0391', 'A'], // alpha
  ['\u0392', 'B'], // beta
  ['\u0395', 'E'], // epsilon
  ['\u0396', 'Z'], // zeta
  ['\u0397', 'H'], // eta
  ['\u0399', 'I'], // iota
  ['\u039A', 'K'], // kappa
  ['\u039C', 'M'], // mu
  ['\u039D', 'N'], // nu
  ['\u039F', 'O'], // omicron
  ['\u03A1', 'P'], // rho
  ['\u03A4', 'T'], // tau
  ['\u03A5', 'Y'], // upsilon
  ['\u03A7', 'X'], // chi
  ['\u03F9', 'C'], // lunate sigma
  // Latin letters outside ASCII
  ['\u0131', 'i'], // dotless i
  ['\u0251', 'a'], // alpha
  ['\u0261', 'g'], // script g
]);
