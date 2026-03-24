import React from "react";
import { render } from "ink";
import chalk from "chalk";
import type { TenetUI, UIEvent, MultiSelectOptions } from "./events.ts";
import { App } from "./ink-app.tsx";

const SEPARATOR = "\u2550".repeat(47);

export function createInkUI(): { ui: TenetUI; unmount: () => void } {
  const events: UIEvent[] = [];
  let spinnerMessage: string | null = null;
  const workerPhases = new Map<number, string>();
  let multiSelectOptions: MultiSelectOptions | null = null;
  let multiSelectResolve: ((values: string[]) => void) | null = null;

  // Banner as first event
  events.push({
    type: "status",
    message: `\n${chalk.cyan(SEPARATOR)}\n${chalk.cyan.bold("  TENET \u2014 Adversarial Agent Testing Framework")}\n${chalk.cyan(SEPARATOR)}\n`,
  });

  function handleMultiSelectComplete(values: string[]): void {
    if (multiSelectResolve) {
      const resolve = multiSelectResolve;
      multiSelectResolve = null;
      multiSelectOptions = null;
      update();
      resolve(values);
    }
  }

  function update(): void {
    instance.rerender(
      React.createElement(App, {
        events: [...events],
        spinnerMessage,
        workerPhases: [...workerPhases.entries()],
        multiSelectOptions,
        onMultiSelectComplete: handleMultiSelectComplete,
      }),
    );
  }

  const instance = render(
    React.createElement(App, {
      events: [...events],
      spinnerMessage: null,
      workerPhases: [],
      multiSelectOptions: null,
      onMultiSelectComplete: handleMultiSelectComplete,
    }),
  );

  const ui: TenetUI = {
    emit(event: UIEvent): void {
      if (event.type === "status" && event.spinner) {
        // Spinner status: show in dynamic section, don't log
        spinnerMessage = event.message.replace(/\n+$/, "");
      } else if (event.type === "worker-phase") {
        // Worker phase: update worker panel, clear spinner
        workerPhases.set(event.workerId, event.phase);
        spinnerMessage = null;
      } else {
        // Regular event: add to static log
        spinnerMessage = null;
        if (event.type === "iteration-complete" || event.type === "unit-batch-complete") {
          workerPhases.clear();
        }
        events.push(event);
      }
      update();
    },
    multiSelect(options: MultiSelectOptions): Promise<string[]> {
      return new Promise((resolve) => {
        multiSelectOptions = options;
        multiSelectResolve = resolve;
        spinnerMessage = null;
        update();
      });
    },
  };

  return { ui, unmount: instance.unmount };
}
