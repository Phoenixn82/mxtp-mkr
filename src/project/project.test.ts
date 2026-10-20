import { describe, expect, it } from "vitest";
import { createProject, parseProject, serializeProject } from "./project";

describe("project store", () => {
  it("round-trips project JSON", () => {
    const project = createProject("Discovery Mix");
    project.metadata = { artist: "Daft Punk", album: "Discovery", year: 2001 };
    const parsed = parseProject(serializeProject(project));
    expect(parsed).toEqual(project);
  });
});
