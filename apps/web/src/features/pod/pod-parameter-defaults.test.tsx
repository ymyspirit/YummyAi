import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PodParameterDefaults,
  ParameterInput,
  ParameterSelect,
  ParameterTextArea,
  podParameterFormDefaults,
} from "./pod-parameter-defaults";
import { PodToolParameters } from "./pod-task-create-panel";

describe("POD repair defaults", () => {
  it("retains false and zero, converts confidence to form percent and restores line lists", () => {
    expect(
      podParameterFormDefaults({
        multiCrop: false,
        padding: 0,
        minimumConfidence: 0.85,
        colors: ["navy", "white"],
        unsafeObject: { value: "ignored" },
      }),
    ).toEqual({ multiCrop: false, padding: 0, minimumConfidence: 85, colors: "navy\nwhite" });
  });
  it("renders saved controls while preserving code-owned hidden constraints", () => {
    const html = renderToStaticMarkup(
      <PodParameterDefaults
        values={{ amount: 0, enabled: false, mode: "saved", notes: "saved notes", fixed: false }}
      >
        <ParameterInput name="amount" type="number" defaultValue={5} />
        <ParameterInput name="enabled" type="checkbox" defaultChecked />
        <ParameterInput name="fixed" type="hidden" value="true" />
        <ParameterSelect name="mode" defaultValue="initial">
          <option value="initial">Initial</option>
          <option value="saved">Saved</option>
        </ParameterSelect>
        <ParameterTextArea name="notes" defaultValue="initial" />
      </PodParameterDefaults>,
    );
    expect(html).toContain('name="amount" value="0"');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('name="fixed" value="true"');
    expect(html).toContain('<option value="saved" selected="">');
    expect(html).toContain('name="notes">saved notes</textarea>');
  });
  it("restores actual crop controls without enabling an incompatible automatic multi-crop", () => {
    const html = renderToStaticMarkup(
      <PodToolParameters
        toolKey="pattern_crop"
        initialValues={{
          mode: "general",
          multiCrop: false,
          maximumCropsPerInput: 1,
          outputFormat: "png",
          background: "preserved",
          perspectiveCorrection: true,
          cropPaddingPercent: 0,
        }}
      />,
    );
    expect(html).toMatch(/name="cropPaddingPercent"[^>]*value="0"/);
    expect(html).not.toMatch(/name="multiCrop"[^>]*checked/);
  });
});
