import { describe, expect, it } from "vitest";
import {
  createConceptId,
  mapRelationshipTypeToEdge,
  normalizeConceptKey,
  relationshipsToEdges
} from "../src/graph-mapping.js";
import type { DocNexusMetadata } from "../src/types.js";

describe("graph mapping", () => {
  it("creates deterministic concept ids from normalized name and type", () => {
    expect(normalizeConceptKey(" Component ", "tool")).toBe("tool:component");
    expect(createConceptId(" DocNexus ", "component")).toBe(createConceptId("docnexus", "component"));
    expect(createConceptId("DocNexus", "component")).toMatch(/^concept_[0-9a-f]{16}$/);
  });

  it("maps metadata relationship types to LadybugDB edge labels", () => {
    expect(mapRelationshipTypeToEdge("depends_on")).toBe("DEPENDS_ON");
    expect(mapRelationshipTypeToEdge("mentions")).toBe("RELATES_TO");
    expect(mapRelationshipTypeToEdge("relates_to")).toBe("RELATES_TO");
    expect(mapRelationshipTypeToEdge("implements")).toBe("IMPLEMENTS");
    expect(mapRelationshipTypeToEdge("replaces")).toBe("REPLACES");
    expect(mapRelationshipTypeToEdge("decides")).toBe("DECIDES");
  });

  it("creates placeholder concepts for relationship endpoints not listed as entities", () => {
    const metadata: DocNexusMetadata = {
      title: "Graph Mapping",
      summary: "Graph mapping test metadata for DocNexus relationship endpoint handling.",
      tags: ["graph"],
      entities: [{ name: "DocNexus", type: "component", description: "Local memory service." }],
      relationships: [{ from: "DocNexus", to: "LadybugDB", type: "depends_on", description: "Stores graph recall." }]
    };

    const mapped = relationshipsToEdges(metadata);

    expect(mapped.concepts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "DocNexus", type: "component" }),
        expect.objectContaining({
          name: "LadybugDB",
          type: "other",
          description: "Referenced by metadata relationship."
        })
      ])
    );
    expect(mapped.edges).toEqual([
      expect.objectContaining({
        label: "DEPENDS_ON",
        from: expect.stringMatching(/^concept_[0-9a-f]{16}$/),
        to: expect.stringMatching(/^concept_[0-9a-f]{16}$/),
        description: "Stores graph recall."
      })
    ]);
  });
});
