import type { ConfiguredAgentOption } from "./Initializer.js";
import type { SupportedAgentInspection } from "./AgentPrerequisites.js";

export interface SelectableDefaultAgent extends ConfiguredAgentOption {
  installedVersion?: string;
}

export function selectableDefaultAgents(
  configured: ConfiguredAgentOption[],
  inspections: SupportedAgentInspection[],
): SelectableDefaultAgent[] {
  const supported = new Map(inspections.map((inspection) => [inspection.id, inspection]));
  return configured.flatMap((agent) => {
    const inspection = supported.get(agent.name as SupportedAgentInspection["id"]);
    if (!inspection?.installedVersion || inspection.compatibilityIssue) return [];
    return [{
      ...agent,
      installedVersion: inspection.installedVersion,
    }];
  });
}

export function resolveAgentConfigurationChoices(
  input: string,
  choices: SelectableDefaultAgent[],
): number[] | undefined {
  const value = input.trim();
  if (!value || /^(?:a|all)$/iu.test(value)) {
    return choices.map((_choice, index) => index);
  }
  const selected = new Set<number>();
  for (const token of value.split(/[,，\s]+/u).filter(Boolean)) {
    const index = resolveDefaultAgentChoice(token, choices);
    if (index === undefined) return undefined;
    selected.add(index);
  }
  return selected.size > 0 ? [...selected].sort((left, right) => left - right) : undefined;
}

export function parseMaintenanceSelection(input: string, choiceCount: number): number[] | undefined {
  const value = input.trim();
  if (!value) return [];
  if (/^(?:a|all)$/iu.test(value)) return Array.from({ length: choiceCount }, (_, index) => index);
  const tokens = value.split(/[,，\s]+/u).filter(Boolean);
  const selected = new Set<number>();
  for (const token of tokens) {
    const number = Number(token);
    if (!Number.isInteger(number) || number < 1 || number > choiceCount) return undefined;
    selected.add(number - 1);
  }
  return [...selected].sort((left, right) => left - right);
}

export function resolveDefaultAgentChoice(
  input: string,
  choices: SelectableDefaultAgent[],
  currentAgent?: string,
): number | undefined {
  const value = input.trim();
  if (!value) {
    const currentIndex = choices.findIndex((choice) => choice.name === currentAgent);
    return currentIndex >= 0 ? currentIndex : undefined;
  }
  const number = Number(value);
  if (Number.isInteger(number) && number >= 1 && number <= choices.length) return number - 1;
  const exactIndex = choices.findIndex((choice) => choice.name === value);
  if (exactIndex >= 0) return exactIndex;
  const folded = value.toLocaleLowerCase("en-US");
  const matches = choices
    .map((choice, index) => ({ choice, index }))
    .filter(({ choice }) => choice.name.toLocaleLowerCase("en-US") === folded);
  return matches.length === 1 ? matches[0]?.index : undefined;
}
