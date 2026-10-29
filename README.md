# Unified-Tray
Replaces both the XApp Status and System Tray applets included with Cinnamon. Shows all status icons, but renders their menus as native Cinnamon panel menus, with an 'Open &lt;Application>' entry at the top for apps whose icon opens a window.

Disclaimer: This was started as a test to see how well AI could do coding something purely from descriptions of what I wanted, with each subsequent iteration coming purely from descriptions of issues or new features that I wanted to see. I've personally not been a fan of generative AI, and I wanted to push on it a bit to see if it could actually do what I hear that it can. I gave it something I thought might be fairly challenging. This code comes 100% from Claude AI. I did not lay a finger on the codebase up until this point. I was surprised and actually rather impressed, to be honest, to the point I thought I should share it.

My goal with this addon was this:
1. I did not like how tray icons never used the panel theme for their menus, and I wanted to find a way to get it themed correctly. This is something that the Linux Mint developers experimented with years ago, but ran into bugs and other issues before they gave up on the idea. This is a challenge because there are several different types of notification tray icon implementations that need to be accounted for.
2. There were two different applets being implemented in Cinnamon in order to get all of the tray icon variations represented. I wanted to unify that into a single applet.
3. The System Tray applet isn't compatible with applets that hide content on the panel (such as the Drawer applet). I wanted to fix that.

Some interesting additional features implemented without my asking by the AI:
1. In order to re-theme the menus of some of the icons, the applet makes calls to AT-SPI, which apparently solved a problem with icons that don't nicely share their menu contents with the applet.
2. The applet "learns" and "remembers" some elements of the menus so that it can show them faster and better upon subsequent viewings. This isn't 100% perfect, but it's ok.
3. Two interaction modes were implemented by the AI. One lets you open a menu with a left mouse click, no matter how the icon normally operates, giving the user an "Open" option in the menu instead of opening when the icon is clicked. This has the effect of unifying how the user interacts with the icons. The other mode is interacting directly with the tray icon the way it normally would, with only theming being the thing that is changed.

I hope you find this applet useful! It was an eye opening experience for me!
