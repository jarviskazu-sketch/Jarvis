# -*- coding: utf-8 -*-
"""
KOKORO — narrador de alta qualidade pro Radar.

Roda 100% local, offline depois do primeiro download, e é gratuito
(modelo Apache 2.0). Falando português do Brasil.

Uso:
    python falar.py <arquivo_de_texto> <arquivo_wav_de_saida> [voz] [velocidade]

Vozes pt-BR (prefixo "p"):
    pf_dora    feminina
    pm_alex    masculina
    pm_santa   masculina

Se algo der errado, sai com código != 0 e o narrar.ps1 cai pro Piper
sozinho — o boletim nunca fica sem áudio por causa disso.
"""

import sys, os, warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def apontar_espeak():
    """No Windows a phonemizer não encontra o espeak-ng sozinha: ela procura a
    DLL pelo PATH do Linux e desiste com "espeak not installed on your system".
    Aqui apontamos o caminho na mão — primeiro o que vem no pacote
    espeakng-loader, depois a instalação do sistema."""
    if os.environ.get("PHONEMIZER_ESPEAK_LIBRARY"):
        return
    try:
        import espeakng_loader
        os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = str(espeakng_loader.get_library_path())
        os.environ["ESPEAK_DATA_PATH"] = str(espeakng_loader.get_data_path())
        return
    except Exception:
        pass
    for dll in (
        r"C:\Program Files\eSpeak NG\libespeak-ng.dll",
        r"C:\Program Files (x86)\eSpeak NG\libespeak-ng.dll",
    ):
        if os.path.exists(dll):
            os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = dll
            dados = os.path.join(os.path.dirname(dll), "espeak-ng-data")
            if os.path.isdir(dados):
                os.environ["ESPEAK_DATA_PATH"] = dados
            return


def main():
    if len(sys.argv) < 3:
        print("uso: falar.py <texto.txt> <saida.wav> [voz] [velocidade]")
        return 2

    entrada, saida = sys.argv[1], sys.argv[2]
    voz = sys.argv[3] if len(sys.argv) > 3 else "pf_dora"
    try:
        velocidade = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    except ValueError:
        velocidade = 1.0

    with open(entrada, encoding="utf-8") as f:
        texto = f.read().strip()
    if not texto:
        print("texto vazio")
        return 3

    apontar_espeak()

    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    # lang_code "p" = português do Brasil
    pipeline = KPipeline(lang_code="p")

    # O Kokoro devolve o áudio em pedaços (ele mesmo quebra o texto).
    # Juntamos tudo num arquivo só, com um respiro curto entre os trechos
    # pra não sair tudo emendado como se fosse uma frase só.
    partes = []
    silencio = np.zeros(int(24000 * 0.18), dtype=np.float32)
    for i, (_, _, audio) in enumerate(pipeline(texto, voice=voz, speed=velocidade)):
        a = audio if isinstance(audio, np.ndarray) else audio.detach().cpu().numpy()
        if i:
            partes.append(silencio)
        partes.append(a.astype(np.float32))

    if not partes:
        print("o modelo nao gerou audio")
        return 4

    final = np.concatenate(partes)
    sf.write(saida, final, 24000)
    print(f"ok {len(final)/24000:.1f}s")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # falha aqui não pode derrubar o boletim: o narrar.ps1 usa o código
        # de saída pra decidir se cai pro Piper
        print(f"erro: {type(e).__name__}: {e}")
        sys.exit(1)
