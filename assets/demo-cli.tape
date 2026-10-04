# jevlint-le — recorded by vhs, driving the real command line against the
# request in demo/.
#
# Reproduce:  bun run build:npm
#             cd assets && vhs demo-cli.tape
#
# This records the command line, not the VS Code extension. The same rules run
# in both, so what it prints here is what the editor underlines.
#
# The first visible frame carries content on purpose: a clip that opens on a
# cleared terminal has a blank still as its poster.
#
# 1200x760 holds about 34 rows at this font size. Content past that scrolls
# and the demo loses its own opening.

Output demo-cli.gif

Set Shell "bash"
Set FontSize 17
Set Width 1200
Set Height 760
Set Padding 24
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

Hide
Type `cd demo && alias jevlint-le="node ../../npm/cli.js" && PS1="$ " && clear`
Enter
Type "cat request.jev.json"
Enter
Sleep 4s
Show

Type "jevlint-le request.jev.json"
Enter
Sleep 9s
