import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCdProject, type CdProject } from "./catalog";
import { RecentProjects } from "./RecentProjects";

function project(overrides: Partial<CdProject> & Pick<CdProject, "id">): CdProject {
  return { ...createCdProject({ artist: "", album: "Mix", formatId: "jewelcase" }), saved: true, ...overrides };
}

describe("RecentProjects", () => {
  it("renders a project whose saved research is partial instead of crashing", () => {
    const partial = project({
      id: "partial",
      name: "Forge Lines",
      entry: { artist: "Iron Meridian", album: "Forge Lines", formatId: "jewelcase" },
      research: {} as CdProject["research"],
      burnQueue: undefined as unknown as CdProject["burnQueue"]
    });
    render(<RecentProjects projects={[partial]} onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open Forge Lines" })).toHaveTextContent("0 tracks · 0 lyrics · 16-page booklet");
  });

  it("labels artist-less projects by kind and keeps 'Recovered playlist' for recovered downloads", () => {
    render(
      <RecentProjects
        projects={[
          project({ id: "road-mix", name: "Road Mix", kind: "custom" }),
          project({ id: "recovered-abc", name: "Downloaded album", kind: "artist" }),
          project({ id: "untitled-release", name: "Untitled release", kind: "artist" })
        ]}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Open Road Mix" })).toHaveTextContent("Custom CD");
    expect(screen.getByRole("button", { name: "Open Road Mix" })).not.toHaveTextContent("Recovered playlist");
    expect(screen.getByRole("button", { name: "Open Downloaded album" })).toHaveTextContent("Recovered playlist");
    expect(screen.getByRole("button", { name: "Open Untitled release" })).toHaveTextContent("Artist release");
  });

  it("shows why projects could not be loaded instead of the empty state", () => {
    render(<RecentProjects projects={[]} error="projects folder is unreadable" onOpen={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Some projects could not be loaded: projects folder is unreadable");
    expect(screen.queryByText("Saved projects and completed burns will appear here.")).not.toBeInTheDocument();
  });
});
