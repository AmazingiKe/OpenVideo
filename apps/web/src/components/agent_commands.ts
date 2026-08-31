export type AgentCommand = {
  name: string;
  label: string;
  description: string;
  task_input: Record<string, unknown>;
  default_instruction?: string;
  instruction_input_key?: string;
  instruction_required?: boolean;
  disabled?: boolean;
  disabled_reason?: string;
};

export type AgentCommandResolution = {
  task_input: Record<string, unknown>;
  error: string | null;
};

export function agent_command_suggestions(
  value: string,
  commands: readonly AgentCommand[],
): AgentCommand[] {
  const match = value.match(/^\/([^\s]*)$/u);
  if (!match) return [];
  const query = match[1] ?? "";
  return commands.filter(
    (command) => command.name.includes(query) || command.label.includes(query),
  );
}

export function resolve_agent_command(
  content: string,
  commands: readonly AgentCommand[],
  base_task_input: Record<string, unknown>,
): AgentCommandResolution {
  const normalized_content = content.trim();
  const command = commands.find((candidate) => {
    const prefix = `/${candidate.name}`;
    return (
      normalized_content === prefix ||
      normalized_content.startsWith(`${prefix} `)
    );
  });
  if (!command) return { task_input: base_task_input, error: null };
  if (command.disabled) {
    return {
      task_input: base_task_input,
      error: command.disabled_reason ?? `“${command.label}”当前不可用`,
    };
  }
  const prefix = `/${command.name}`;
  const explicit_instruction = normalized_content.slice(prefix.length).trim();
  const instruction = explicit_instruction || command.default_instruction;
  if (command.instruction_required && !instruction) {
    return {
      task_input: base_task_input,
      error: `请在 /${command.name} 后说明具体处理要求`,
    };
  }
  const instruction_input =
    command.instruction_input_key && instruction
      ? { [command.instruction_input_key]: instruction }
      : {};
  return {
    task_input: {
      ...base_task_input,
      ...command.task_input,
      ...instruction_input,
    },
    error: null,
  };
}

export function selected_agent_command(
  value: string,
  commands: readonly AgentCommand[],
): AgentCommand | null {
  const normalized_content = value.trim();
  return (
    commands.find((command) => {
      const prefix = `/${command.name}`;
      return (
        normalized_content === prefix ||
        normalized_content.startsWith(`${prefix} `)
      );
    }) ?? null
  );
}
