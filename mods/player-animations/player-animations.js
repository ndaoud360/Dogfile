// @dogmod
// @name Player animations
// @description A spinning record player or a cassette deck in the music view: the record slides in and the needle drops, or the tape slides in and the lid closes
// @target player
// @permissions
// @version 1.0
// @author Dogfile
// @icon music

// The pictures are drawn by Dogfile Player itself (features run in a sandbox and can't draw); this feature picks which one.
// Record player: the record slides in and lands, the needle swings over and drops, then the song starts. Pausing lifts the needle.
// Cassette deck: the lid opens, the tape slides in, the lid closes, then the song starts and the reels turn. Pausing stops them.

const say = { turntable: 'Record player on', cassette: 'Cassette deck on', off: 'Cover picture back' };
async function pick(name) {
  await dogfile.player.setSkin(name);
  dogfile.ui.toast(say[name]);
}

dogfile.addCommand({ id: 'turntable', title: 'Music view: record player', icon: 'music', toolbar: true, run: () => pick('turntable') });
dogfile.addCommand({ id: 'cassette', title: 'Music view: cassette deck', icon: 'music', run: () => pick('cassette') });
dogfile.addCommand({ id: 'off', title: 'Music view: cover picture (animations off)', icon: 'image', run: () => pick('off') });
