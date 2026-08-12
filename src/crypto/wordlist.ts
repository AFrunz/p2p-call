/**
 * Словарь для SAS: ровно 256 слов, то есть 8 бит на слово.
 *
 * Список английский и НЕ локализуется — это не недоделка, а требование.
 * Фразу читают вслух оба участника, и увидеть её они обязаны одинаковой:
 * если словарь поедет за языком интерфейса, собеседники с разными языками
 * увидят разные слова и решат, что их слушают. Английский выбран как язык,
 * который у обеих сторон с большей вероятностью получится и произнести, и
 * узнать на слух.
 *
 * Слова подобраны короткими, конкретными и фонетически различимыми: линия
 * бывает плохой, а сверка идёт голосом. Специально убраны омофоны
 * (kernel/colonel, manor/manner) и пары, различающиеся одним звуком
 * (amber/ember, angle/ankle, bacon/beacon, fennel/funnel).
 *
 * Менять список нельзя без смены версии протокола: стороны на разных версиях
 * увидят разные фразы.
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
