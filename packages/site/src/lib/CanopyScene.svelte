<!--
  Placeholder hero artwork. The real landing page drops in the painted
  canopy illustration; until then this layered SVG keeps the composition
  (glowing star top-right, dark foliage frame, a small lookout figure)
  so the layout reads correctly. Swap the whole component for an <img>
  when the final art lands.
-->
<div class="scene">
  <svg viewBox="0 0 600 520" role="img" aria-label="An explorer on a treetop looking toward a glowing star above the forest canopy">
    <defs>
      <radialGradient id="sky" cx="72%" cy="22%" r="85%">
        <stop offset="0%" stop-color="#3a5c33" />
        <stop offset="55%" stop-color="#243d20" />
        <stop offset="100%" stop-color="#16240f" />
      </radialGradient>
      <radialGradient id="starGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fff6d6" />
        <stop offset="35%" stop-color="#ffd24a" />
        <stop offset="100%" stop-color="rgba(255,210,74,0)" />
      </radialGradient>
      <linearGradient id="leaf" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5b8a3c" />
        <stop offset="100%" stop-color="#2c4a22" />
      </linearGradient>
    </defs>

    <!-- rounded canopy frame -->
    <rect x="0" y="0" width="600" height="520" rx="28" fill="url(#sky)" />

    <!-- glow + star -->
    <circle cx="430" cy="150" r="150" fill="url(#starGlow)" opacity="0.9" />
    <g class="star" transform="translate(430 150)">
      <path
        d="M0 -34 L7 -7 L34 0 L7 7 L0 34 L-7 7 L-34 0 L-7 -7 Z"
        fill="#fff7dd"
      />
      <circle cx="0" cy="0" r="6" fill="#fff" />
    </g>

    <!-- light beam toward the figure -->
    <path d="M430 150 L250 470 L330 470 Z" fill="#ffe9a8" opacity="0.10" />

    <!-- foliage clumps framing the corners -->
    <g fill="url(#leaf)">
      <ellipse cx="70" cy="80" rx="130" ry="95" />
      <ellipse cx="540" cy="470" rx="160" ry="120" />
      <ellipse cx="120" cy="470" rx="150" ry="120" />
      <ellipse cx="560" cy="60" rx="90" ry="70" opacity="0.8" />
    </g>

    <!-- the treetop perch + lookout figure -->
    <g transform="translate(250 360)">
      <ellipse cx="40" cy="86" rx="120" ry="38" fill="#2c4a22" />
      <path
        d="M40 78 C20 70 18 50 28 40 C30 24 52 24 56 38 C70 40 70 62 52 70 Z"
        fill="#1c3214"
      />
      <!-- figure -->
      <g fill="#14240e">
        <circle cx="44" cy="20" r="9" />
        <path d="M44 28 q-4 14 -2 26 l10 0 q4 -16 -2 -26 z" />
        <!-- raised arm holding a spyglass toward the star -->
        <path
          d="M50 34 L84 16 l4 7 l-34 18 z"
        />
      </g>
    </g>

    <!-- drifting fireflies -->
    <g fill="#ffe9a8">
      <circle class="spark s1" cx="300" cy="120" r="2.5" />
      <circle class="spark s2" cx="360" cy="260" r="2" />
      <circle class="spark s3" cx="200" cy="220" r="2.2" />
      <circle class="spark s4" cx="470" cy="320" r="2" />
    </g>
  </svg>
</div>

<style>
  .scene {
    position: relative;
    width: 100%;
    filter: drop-shadow(0 30px 50px rgba(29, 44, 26, 0.35));
  }
  svg {
    width: 100%;
    height: auto;
    display: block;
  }

  .star {
    transform-box: fill-box;
    transform-origin: center;
    animation: twinkle 4s ease-in-out infinite;
  }
  @keyframes twinkle {
    0%,
    100% {
      transform: translate(430px, 150px) scale(1) rotate(0deg);
      opacity: 1;
    }
    50% {
      transform: translate(430px, 150px) scale(1.12) rotate(8deg);
      opacity: 0.85;
    }
  }

  .spark {
    animation: float 6s ease-in-out infinite;
  }
  .s2 {
    animation-delay: -1.5s;
  }
  .s3 {
    animation-delay: -3s;
  }
  .s4 {
    animation-delay: -4.5s;
  }
  @keyframes float {
    0%,
    100% {
      transform: translateY(0);
      opacity: 0.4;
    }
    50% {
      transform: translateY(-10px);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .star,
    .spark {
      animation: none;
    }
  }
</style>
