/**
 * 256 слов для SAS — по слову на байт.
 *
 * НЕ локализуется: обе стороны обязаны увидеть одну фразу, иначе разошедшийся
 * язык интерфейса читается как «нас слушают». Убраны омофоны и пары в один
 * звук — фразу сверяют голосом. Смена списка требует смены версии протокола.
 */
export const SAS_WORDS: readonly string[] = [
  'acid', 'acorn', 'actor', 'album', 'alcove', 'alien', 'almond', 'alpha',
  'amber', 'anchor', 'angle', 'anthem', 'antler', 'apple', 'arena', 'armor',
  'arrow', 'atlas', 'atom', 'aurora', 'autumn', 'avenue', 'badge', 'bagel',
  'ballad', 'bamboo', 'banana', 'banjo', 'barrel', 'basket', 'battery', 'beacon',
  'beetle', 'bench', 'berry', 'bishop', 'bison', 'blanket', 'blossom', 'bobcat',
  'bonus', 'boulder', 'bracket', 'branch', 'bravo', 'bridge', 'bronze', 'brush',
  'bubble', 'bucket', 'buffalo', 'bulldog', 'bunker', 'burger', 'cabin', 'cable',
  'cactus', 'camel', 'campus', 'candle', 'canvas', 'canyon', 'carbon', 'cargo',
  'carpet', 'carrot', 'cashew', 'casino', 'castle', 'cedar', 'cello', 'chapel',
  'cheddar', 'cherry', 'chess', 'chimney', 'chorus', 'chowder', 'cinema', 'citrus',
  'clamp', 'clarinet', 'cliff', 'clover', 'chestnut', 'cobra', 'cocoa', 'coffee',
  'comet', 'compass', 'condor', 'copper', 'coral', 'cosmos', 'cotton', 'cougar',
  'cradle', 'curtain', 'crayon', 'cricket', 'crimson', 'crystal', 'cube', 'cushion',
  'dagger', 'daisy', 'dancer', 'delta', 'denim', 'diamond', 'diesel', 'digit',
  'diver', 'doctor', 'dolphin', 'domino', 'donkey', 'dragon', 'drift', 'drum',
  'duckling', 'dune', 'dusk', 'eagle', 'easel', 'echo', 'eclipse', 'elbow',
  'elder', 'emerald', 'engine', 'envelope', 'estate', 'faucet', 'fabric', 'falcon',
  'feather', 'fennel', 'fern', 'fiber', 'fiddle', 'figure', 'filter', 'finch',
  'flamingo', 'flannel', 'flask', 'flint', 'flute', 'forest', 'fossil', 'fortress',
  'fox', 'fresco', 'frost', 'furnace', 'galaxy', 'gadget', 'garden', 'garlic',
  'gondola', 'gazelle', 'gecko', 'ginger', 'giraffe', 'glacier', 'glider', 'globe',
  'goblet', 'gopher', 'granite', 'grape', 'gravel', 'grotto', 'guitar', 'hammer',
  'hedgehog', 'harbor', 'harvest', 'hazel', 'helmet', 'heron', 'hickory', 'hollow',
  'honey', 'horizon', 'hotel', 'hunter', 'husky', 'indigo', 'insect', 'iris',
  'island', 'ivory', 'jacket', 'jaguar', 'jasmine', 'jazz', 'jelly', 'jersey',
  'jewel', 'jungle', 'juniper', 'kayak', 'kettle', 'keyboard', 'kitten', 'koala',
  'ladder', 'lagoon', 'lantern', 'lark', 'laser', 'laundry', 'lava', 'lemon',
  'lentil', 'leopard', 'lever', 'lilac', 'ledger', 'linen', 'lizard', 'lobster',
  'locker', 'lotus', 'lumber', 'lunar', 'lynx', 'mammoth', 'magnet', 'mango',
  'maple', 'marble', 'mattress', 'midnight', 'mascot', 'meadow', 'monarch', 'mahogany',
  'mentor', 'mercury', 'meteor', 'mineral', 'mirror', 'mixer', 'mocha', 'mosaic',
  'motor', 'mountain', 'muffin', 'mural', 'museum', 'mustard', 'nectar', 'nutmeg',
]
