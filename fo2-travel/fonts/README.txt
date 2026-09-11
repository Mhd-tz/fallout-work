Typefaces used by the NAVCOM travel view
========================================

Fallout's interface type, across the whole series, is condensed grotesque.
Fallout 1/2 set their titles in Gothic 821 Condensed and their monochrome text
in JH Fallout; Fallout 3/NV/4 set the Pip-Boy and the terminals in Monofonto.
None of those can be redistributed, so each role has a drop-in slot: put the
real file here under the exact name below and travel.css picks it up ahead of
the stand-in. No code change, no rebuild.

  ROLE      ORIGINAL                     DROP-IN NAME      SHIPPED STAND-IN
  display   Gothic 821 Condensed (BT)    gothic821.ttf     anton.ttf
  body      Monofonto (FO3/NV/4)         monofonto.ttf     oswald-*.ttf
            JH Fallout (FO1/2)           jh-fallout.ttf
  buttons   Monofonto / Overseer         overseer.ttf      oswald-*.ttf
  data      Monofonto                    monofonto.ttf     sharetechmono.ttf

An installed system copy beats both. The stacks name "Gothic 821 Condensed
BT", "Monofonto", "Overseer" and "JH Fallout" first, so a player who already
has them gets the real faces with no files here at all.

Where to find the originals
---------------------------
  Gothic 821 Condensed  Bitstream, sold commercially (MyFonts and others).
  Monofonto             Typodermic / Ray Larabie. Older releases circulated as
                        freeware; current ones are commercial.
  JH Fallout            Made for Fallout in 1997. Free, but hosted behind a
                        No Mutants Allowed forum account:
                        nma-fallout.com/resources/fallout-fonts.79/
  Overseer              Fan-made Fallout display family, free for fan use.

Shipped files
-------------
  anton.ttf                      SIL OFL 1.1 - heavy condensed grotesque, the
                                 closest free match for Gothic 821 Condensed.
  oswald-300/400/500/600/700.ttf SIL OFL 1.1 - condensed grotesque, the
                                 closest free match for the Pip-Boy and
                                 terminal face. Does the bulk of the work.
  sharetechmono.ttf              SIL OFL 1.1 - fixed width, for readouts where
                                 the columns have to line up.
  fo2-terminal.ttf               Authored here (see make-font.py): a pixel
                                 face built from bitmap grids. Not in any
                                 stack by default - it reads as 8-bit rather
                                 than as Fallout - but it is kept for anyone
                                 who wants that look. Add it to --body in
                                 travel.css to switch it on.

  OFL.txt                        The SIL Open Font License, covering anton,
                                 oswald and sharetechmono.
