# Teaching the project owner

When creating or updating any project Markdown file, explain the part of OpticPR it covers in terms the owner can follow. Define unfamiliar terms on first use. In a plan or spec, describe the intended behavior and how the owner will observe it. In a runbook, explain what a command does and how to interpret its output. In a results document, connect the measurements to the behavior they demonstrate.

After implementing a feature, add an implementation walkthrough to its feature spec and teach the owner directly in the completion message. Write the walkthrough from the actual code and verification results. Cover these questions:

- What changed, what problem did it solve, and which files or functions implement it?
- How does one concrete input travel through the system, and what does the reviewer see?
- Why was the main design choice made? What happens in a relevant failure or edge case?
- How can the owner reproduce the example locally? Give the command, the expected observation, the checks actually run and any limits of the evidence.

Link to the relevant code and tests. Use the feature’s teaching prompt to choose the example. Keep planned work, expected outcomes and observed results clearly identified.
