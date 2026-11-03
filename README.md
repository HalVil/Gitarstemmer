# Gitarstemmer

Enkel stemmer for akustisk gitar med seks strenger i standardstemming (E A D G B E).

Trykk **Start**, gi nettleseren tilgang til mikrofonen, og spill strengene. Stemmeren finner strengen selv, viser om den er for lav, for høy eller stemt, og setter en hake når den har holdt seg stemt et øyeblikk. Referansetone og låsing av én streng er egne valg under startknappen.

Lyden behandles bare i nettleseren og sendes ikke videre.

**Åpne stemmeren:** https://halvil.github.io/Gitarstemmer/

Virker i Chrome, Safari (inkludert iPhone og iPad) og Firefox.

Tonegjenkjenningen kan sjekkes med `node test/pitch.test.mjs`.
