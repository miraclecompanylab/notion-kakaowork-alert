export const won = (n) => {
  const eok = Math.floor(n / 1e8), man = Math.round((n % 1e8) / 1e4);
  let s = eok ? `${eok}억` : "";
  if (man) {
    const ch = Math.floor(man / 1000), bk = Math.floor((man % 1000) / 100), rest = man % 100;
    s += rest ? `${man.toLocaleString()}만` : `${ch ? ch + "천" : ""}${bk ? bk + "백" : ""}만`;
  }
  return s + "원";
};
