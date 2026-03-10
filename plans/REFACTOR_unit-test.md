# New feature: unit test

Tenet now can only run target project fully. Meaning, target project is always "up" with all the components loaded. This is like "integration test" from traditional programming. Now, let's create the "unit test" capability for Tenet.

## Before this refactor, there is only integration test in `claude-tenet`.
And it's not working very well. The "Pass" green light is too easy. Sometime, a component is loaded/called, then Tenet consider this component is "pass". We need to really test it out.

## Mindset or philosophy of the "unit test"
For complete testing of any component, there 2 "stages". First one is the "successfully loaded" stage, which is covered by the integration test. Second stage happens after the first stage, which is the "intense pressure test", that we target "a component" and Tenet need to try its best to "test the shit out of it".

* Integration test is responsible for testing whether the components are successfully loaded/called.
* Unit test is responsible for making sure the test coverage of each component is 100%. Meaning, creating different kind of scenarios/prompts...etc to test it. Even, to create "traps" for each component to see whether it's robust and smart enough.

## The new mindset/philosophy of the original integration test
Focus on, whether any component can be "loaded/called" smoothly. Why? An issue happens a lot which is a component is not "linked" with the whole claude agent project properly. Some components can only be triggered/called with really explicit prompt. Otherwise, be ignored. Since we add "unit test" capability now, we should shift the existing test (integration test) to focus on this topic more.
s
### "Bottom-Up" checking of integration test. Only one-way checking, not bidirectional.
For running integration test on a/some components, the definition of "well linked" is: Is my parent (CLAUDE.md or sub-agent) calling me smoothly. Here are the checking direction of each component type:
  * CLAUDE.md => No integration test since it has no parent.
  * Sub-Agent => Is CLAUDE.md or which sub-agent calling me smoothly.
  * All other components => Is CLAUDE.md or which sub-agent calling me smoothly.
  
Please note, only CLAUDE.md and sub-agent can "call" tool components and all tool components can just be waited to called passively.

## Each component has its own way of "unit test"
There are 2 "setup", "complete setup" and "focus setup". Each component type is specified which setup to use.

### Sibiling folder for the "instance"
Not like "integration test", that using the original/existing project. For unit test (still, using the red team blue team way), we copy all/some components to a folder Tenet create, which is next to the current project because some projects "load" files outside of project scope so this "instance" can keep all the functionality as the original project. The steps can be:
  * Create the folder
  * Copy components
  * Run some unit tests
  * Complete. Delete the folder.

All the "create/copy/delete" are done by "code". Nothing to do with LLM capability.

### How unit test be executed of each component type

#### CLAUDE.md (complete setup)
* Setup: Load all the components from the project since this is the "root" of agent project. We need all components.
* Notes:
  * CLAUDE.md has no integration test since it always be "called" with user prompt. There is no chance that it will be ignored.

#### Sub Agent (focus setup)
* Setup: Instead of the original CLUADE.md as the `systemPrompt` field of `Options` of sdk, we let the markdown file of this sub-agent as the `systemPrompt` field and load all other tool components.

#### Tool Component: Skill, Command, Hook, Knowledge files (focus setup)
* Setup: Tenet need to read files to understand this tool, CLAUDE.md and all sub-agents well enough that Tenet need to pick either CLAUDE.md or which sub-agent as the `systemPrompt` of this focus setup. The only criteria of picking is, the agent that use this tool the most. Please note, do not modify the content of CLAUDE.md or the sub-agent. Finally, copy this tool and those tools that be used by this tool.


#### MCP
WE DO NOT SUPPORT UNIT TEST FOR MCP. MCP only has integration test.
