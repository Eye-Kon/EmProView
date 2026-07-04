# EmProView - System Blueprint & Core Vision

## 1. Core Vision
EmProView is a safety-critical, web-based Air Traffic Control (ATC) data visualization utility. It bridges the gap between proprietary airline single-engine emergency procedures and live ATC radar monitoring.

## 2. The Core Problem & Solution
*   **Problem:** Airline engine-out and missed approach emergency procedures are highly non-standard, buried in dense text tables within proprietary carrier charts, and completely invisible to ATC controllers during a time-critical emergency.
*   **Solution:** An AI-powered data-normalization engine that ingests unstructured carrier charts, extracts the conditional flight path rules into a strict JSON schema, and dynamically displays the predictive geometric flight path vector to a controller display.

## 3. Product Architecture Roadmap
*   **Phase 1 (The Independent Terminal):** A standalone, responsive web interface designed for a secondary touchscreen information terminal (simulating an ATC NIDS/IDS-4 display). It features a simulated radar target display on the left and an instant emergency flight path vector generation on the right.
*   **Phase 2 (The Data Distribution API):** A low-latency secure data feed that streams normalized geometric tracks (`[SFO04] -> [Left Turn 100°]`) directly to terminal radar automation systems (like STARS) via standard API protocols.

## 4. Engineering Priorities & Constraints
*   **Zero-Form Ingestion:** Ingestion must utilize a multimodal AI pipeline (Unstructured PDF In ➔ Structured Data Out) to completely bypass manual form entry for airport, runway, and fleet metadata.
*   **Deterministic Integrity:** All extracted data must strictly map to a uniform, non-nullable JSON schema. No raw AI text may ever be committed to a live terminal display without a "Human-in-the-Loop" verification handshake.
*   **Tech Stack:** Node.js backend, OpenAI API integration, Tailwind CSS frontend layout.

Next Step: Execute the missing-data stress test on the Delta conditional route to observe UI failure states.
