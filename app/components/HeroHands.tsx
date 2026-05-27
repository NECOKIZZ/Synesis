"use client";

import React from "react";
import Image from "next/image";

export default function HeroHands() {
  return (
    <>
      {/* Robot hand — bottom-left, reaching upper-right toward coin */}
      <div className="hidden md:block" style={{
        position: "absolute",
        bottom: "-25%",
        left: "-12%",
        zIndex: 20,
        width: "clamp(500px, 58vw, 1000px)",
        animation: "slide-in-left 1.5s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both",
        pointerEvents: "none",
      }}>
        <div style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1.46 / 1",
          filter: "brightness(1.05) contrast(1.05)",
        }}>
          <Image
            src="/robot-hand.png"
            alt="Robotic hand reaching toward USDC coin"
            fill
            style={{
              objectFit: "contain",
              objectPosition: "bottom left",
            }}
            sizes="(max-width: 768px) 70vw, 58vw"
            priority
          />
        </div>
      </div>

      {/* Human hand — top-right, reaching down-left toward coin */}
      <div className="hidden md:block" style={{
        position: "absolute",
        top: "-12%",
        right: "-5%",
        zIndex: 20,
        width: "clamp(450px, 52vw, 900px)",
        animation: "slide-in-right 1.5s cubic-bezier(0.16, 1, 0.3, 1) 0.4s both",
        pointerEvents: "none",
      }}>
        <div style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1.77 / 1",
          filter: "brightness(1.05) contrast(1.05)",
        }}>
          <Image
            src="/human-hand.png"
            alt="Human hand reaching toward USDC coin"
            fill
            style={{
              objectFit: "contain",
              objectPosition: "top right",
            }}
            sizes="(max-width: 768px) 60vw, 52vw"
            priority
          />
        </div>
      </div>
    </>
  );
}
