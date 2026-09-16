"use client";

import { useEffect, useState } from "react";

import { PRIMARY_DESTINATIONS } from "./navigation-registry";

export const favoritePagesKey = "yummyai.ui.favorite-pages";
const defaultFavorites = ["orders", "production-editor", "products", "suppliers"];

function readFavoritePages() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(favoritePagesKey) ?? "null");
    if (Array.isArray(value)) return [...new Set(value.filter((id): id is string => typeof id === "string" && PRIMARY_DESTINATIONS.some((item) => item.id === id)))];
  } catch { /* Invalid or blocked storage falls back to the default shortcuts. */ }
  return defaultFavorites;
}

export function useFavoritePages() {
  const [favorites, setFavorites] = useState<string[]>(defaultFavorites);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setFavorites(readFavoritePages());
    setReady(true);
    function handleStorage(event: StorageEvent) {
      if (event.key === favoritePagesKey || event.key === null) setFavorites(readFavoritePages());
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(favoritePagesKey, JSON.stringify(favorites)); } catch { /* In-memory favorites remain usable. */ }
  }, [favorites, ready]);
  function toggleFavorite(id: string) {
    setFavorites((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }
  return { favorites, toggleFavorite };
}
