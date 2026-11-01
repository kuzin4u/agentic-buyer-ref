// Адрес страницы УПК для человека (Р69 п. 5, К1.5): только абсолютный https: без логина и пароля; иначе ссылки нет —
// человек подтверждает в приложении банка (fail-closed).
import { describe, expect, it } from "vitest";
import { pageLink } from "../../src/agent/confirmations/link.js";

describe("pageLink — ссылка страницы УПК (Р69 п. 5)", () => {
  it("абсолютный https: — разобранный адрес", () => {
    expect(pageLink("https://upk.stand/c/cnf_1")).toBe("https://upk.stand/c/cnf_1");
    expect(pageLink("https://upk.stand:8443/c/cnf_1?lang=en")).toBe("https://upk.stand:8443/c/cnf_1?lang=en");
    // кириллица в пути — кодируется, как в адресной строке
    expect(pageLink("https://upk.stand/c/страница")).toBe("https://upk.stand/c/%D1%81%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D0%B0");
  });

  it("не https:, логин или пароль в адресе, относительный, управляющие символы, длинный, не строка — ссылки нет", () => {
    const bad: [string, unknown][] = [
      ["http:", "http://upk.stand/c/cnf_1"],
      ["javascript:", "javascript:alert(1)"],
      ["data:", "data:text/html,<b>x</b>"],
      ["file:", "file:///etc/passwd"],
      ["логин и пароль", "https://user:secret@upk.stand/c/cnf_1"],
      ["только логин", "https://user@upk.stand/c/cnf_1"],
      ["относительный", "/c/cnf_1"],
      ["без схемы", "upk.stand/c/cnf_1"],
      ["пробел", "https://upk.stand/c/cnf 1"],
      ["перевод строки", "https://upk.stand/c/cnf_1\nПодтвердите здесь"],
      ["нулевой символ", "https://upk.stand/c/cnf_1\u0000"],
      ["C1", "https://upk.stand/c/cnf_1\u0085"],
      ["длиннее предела", `https://upk.stand/c/${"a".repeat(2048)}`],
      ["пустая", ""],
      ["null", null],
      ["число", 42],
    ];
    for (const [name, v] of bad) expect(pageLink(v), name).toBeNull();
  });
});
