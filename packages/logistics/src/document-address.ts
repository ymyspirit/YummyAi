/** Formatting only. Never repairs or invents a recipient's identity or location. */
const states: Record<string, string> = {
  AL:"Alabama", AK:"Alaska", AS:"American Samoa", AZ:"Arizona", AR:"Arkansas", CA:"California", CO:"Colorado",
  CT:"Connecticut", DE:"Delaware", DC:"District of Columbia", FM:"Federated States of Micronesia", FL:"Florida",
  GA:"Georgia", GU:"Guam", HI:"Hawaii", ID:"Idaho", IL:"Illinois", IN:"Indiana", IA:"Iowa", KS:"Kansas", KY:"Kentucky",
  LA:"Louisiana", ME:"Maine", MH:"Marshall Islands", MD:"Maryland", MA:"Massachusetts", MI:"Michigan", MN:"Minnesota",
  MS:"Mississippi", MO:"Missouri", MT:"Montana", NE:"Nebraska", NV:"Nevada", NH:"New Hampshire", NJ:"New Jersey",
  NM:"New Mexico", NY:"New York", NC:"North Carolina", ND:"North Dakota", MP:"Northern Mariana Islands", OH:"Ohio",
  OK:"Oklahoma", OR:"Oregon", PW:"Palau", PA:"Pennsylvania", PR:"Puerto Rico", RI:"Rhode Island", SC:"South Carolina",
  SD:"South Dakota", TN:"Tennessee", TX:"Texas", UT:"Utah", VT:"Vermont", VI:"Virgin Islands", VA:"Virginia",
  WA:"Washington", WV:"West Virginia", WI:"Wisconsin", WY:"Wyoming", AE:"Armed Forces Europe, the Middle East, and Canada",
  AP:"Armed Forces Pacific", AA:"Armed Forces Americas (except Canada)",
};
const key = (value: string) => value.trim().replaceAll(".", "").replace(/\s+/g, " ").toLowerCase();
const lookup = new Map(Object.entries(states).flatMap(([code, name]) => [[key(code), code], [key(name), code]]));
for (const [name, code] of Object.entries({ "US Virgin Islands":"VI", "United States Virgin Islands":"VI",
  "Armed Forces Europe":"AE", "Armed Forces Americas":"AA", "Washington DC":"DC", "Washington, DC":"DC" })) lookup.set(key(name), code);
export function normalizeDocumentRegion(region: string, country: string): { value: string; valid: boolean } {
  if (country !== "US") return { value: region.trim(), valid: true };
  const value = lookup.get(key(region));
  return { value: value ?? region.trim(), valid: !!value };
}
export function yunexpressRecipientProblem(name: string): string | null {
  const words = name.trim().split(/\s+/u).filter(word => /\p{L}/u.test(word));
  return words.length < 2 ? "云途收件人姓名不能是单个字母或单个单词 请核对客户真实完整姓名" : null;
}
