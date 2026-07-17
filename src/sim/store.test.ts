import { afterEach, describe, expect, it } from "vitest";
import { docFromJSON, docToJSON } from "./anatomyDoc";
import { NORMAL_DOC } from "./anatomy";
import { useSim } from "./store";

afterEach(() => useSim.getState().closeLocalCase());

describe("external anatomy activation", () => {
  it("selects the loaded document's access and target atomically", () => {
    const doc = docFromJSON(docToJSON(NORMAL_DOC));
    doc.id = "local-test";
    doc.name = "Local test";
    doc.access = [{ id: "custom-access", name: "Custom access", onBranch: "aorta", at: "start", dir: [0, 1, 0] }];
    doc.targets = [{ id: "custom-target", name: "Custom target", via: "aorta", pos: [0, 20, 0], acceptance: 1 }];

    useSim.getState().loadDoc(doc);
    expect(useSim.getState().loadedDoc?.id).toBe("local-test");
    expect(useSim.getState().accessId).toBe("custom-access");
    expect(useSim.getState().targetId).toBe("custom-target");

    useSim.getState().closeLocalCase();
    expect(useSim.getState().loadedDoc).toBeNull();
    expect(useSim.getState().accessId).toBe("rcfa");
    expect(useSim.getState().targetId).toBe("t_renal_l");
  });
});

