# Gitarstemmer

Enkel stemmer for akustisk gitar med seks strenger i standardstemming (E A D G B E).

Trykk **Start**, gi nettleseren tilgang til mikrofonen, og spill en streng. Stemmeren viser tonen, hvor mange cent den er for lav eller for høy, og om strengen er stemt. Trykk på en streng for å låse den, eller spill en referansetone.

Lyden behandles bare i nettleseren og sendes ikke videre.

**Åpne stemmeren:** https://halvil.github.io/Gitarstemmer/

Virker i Chrome, Safari (inkludert iPhone og iPad) og Firefox.

Tonegjenkjenningen kan sjekkes med `node test/pitch.test.mjs`.
