import { describe, expect, it } from "vitest";

import {
  agent_command_suggestions,
  resolve_agent_command,
  selected_agent_command,
  type AgentCommand,
} from "./agent_commands";

const COMMANDS: AgentCommand[] = [
  {
    name: "修正选中字幕",
    label: "快速修正选中字幕",
    description: "修正错字",
    task_input: { intent: "transcript_edit", segment_indices: [1, 2] },
    default_instruction: "根据上下文修正错字。",
    instruction_input_key: "correction_instruction",
  },
  {
    name: "处理全部字幕",
    label: "处理全部字幕",
    description: "按说明处理",
    task_input: { intent: "transcript_edit", segment_indices: null },
    instruction_input_key: "correction_instruction",
    instruction_required: true,
  },
];

describe("agent commands", () => {
  it.each([" ", "\n", "\t", "　"])(
    "retains target language and selection with separator %j",
    (separator) => {
      const content = `/修正选中字幕${separator}翻译成英文`;
      expect(resolve_agent_command(content, COMMANDS, {}).task_input).toEqual({
        intent: "transcript_edit",
        segment_indices: [1, 2],
        correction_instruction: "翻译成英文",
      });
      expect(selected_agent_command(content, COMMANDS)).toEqual(COMMANDS[0]);
    },
  );

  it("does not recognize a command prefix as a complete command", () => {
    const content = "/修正选中字幕备注 翻译成英文";
    expect(resolve_agent_command(content, COMMANDS, {}).task_input).toEqual({});
    expect(selected_agent_command(content, COMMANDS)).toBeNull();
  });

  it("lists matching commands after a slash", () => {
    expect(agent_command_suggestions("/字幕", COMMANDS)).toEqual(COMMANDS);
    expect(agent_command_suggestions("普通问题", COMMANDS)).toEqual([]);
  });

  it("resolves quick correction with its default instruction", () => {
    expect(resolve_agent_command("/修正选中字幕", COMMANDS, {})).toEqual({
      task_input: {
        intent: "transcript_edit",
        segment_indices: [1, 2],
        correction_instruction: "根据上下文修正错字。",
      },
      error: null,
    });
  });

  it("requires an instruction for full transcript processing", () => {
    expect(resolve_agent_command("/处理全部字幕", COMMANDS, {}).error).toBe(
      "请在 /处理全部字幕 后说明具体处理要求",
    );
    expect(
      resolve_agent_command(
        "/处理全部字幕 翻译成中文并保留专业术语",
        COMMANDS,
        {},
      ),
    ).toEqual({
      task_input: {
        intent: "transcript_edit",
        segment_indices: null,
        correction_instruction: "翻译成中文并保留专业术语",
      },
      error: null,
    });
  });
});
