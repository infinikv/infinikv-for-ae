#!/bin/bash

# Build script for InfiniKV with precompiled GeminiFS
# This script first builds GeminiFS libraries, then builds the Python extension

set -e

echo "=== Building InfiniKV with GeminiFS ==="

# Prefer running with a virtualenv Python to avoid system setuptools/distutils issues.
# Priority:
# 1) Activated venv: $VIRTUAL_ENV/bin/python
# 2) Project-local venv: <repo_root>/.venv/bin/python
# 3) Fallback: python3
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON=""
if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "${VIRTUAL_ENV}/bin/python" ]; then
    PYTHON="${VIRTUAL_ENV}/bin/python"
elif [ -x "${ROOT_DIR}/.venv/bin/python" ]; then
    PYTHON="${ROOT_DIR}/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON="$(command -v python3)"
else
    echo "Error: No python interpreter found. Please activate a venv or install python3."
    exit 1
fi
echo "Using Python: ${PYTHON}"

# Check if CUDA is available
if ! command -v nvcc &> /dev/null; then
    echo "Error: CUDA compiler (nvcc) not found. Please install CUDA toolkit."
    exit 1
fi

# Step 1: Build GeminiFS libraries using CMake
echo "Step 1: Building GeminiFS libraries..."
cd csrc/GeminiFS

# Check if build directory exists, create if not
if [ ! -d "build" ]; then
    mkdir build
fi

cd build

# Configure with CMake
echo "Configuring GeminiFS with CMake..."
TORCH_DIR_ARG=""
if "${PYTHON}" -c "import torch" >/dev/null 2>&1; then
    TORCH_CMAKE_DIR="$("${PYTHON}" -c "import os, torch; print(os.path.join(torch.utils.cmake_prefix_path, 'Torch'))")"
    if [ -d "${TORCH_CMAKE_DIR}" ]; then
        echo "Detected PyTorch CMake config from current Python env: ${TORCH_CMAKE_DIR}"
        TORCH_DIR_ARG="-DTorch_DIR=${TORCH_CMAKE_DIR}"
    else
        echo "Warning: PyTorch found in Python, but Torch CMake directory not found at: ${TORCH_CMAKE_DIR}"
    fi
else
    echo "Warning: PyTorch not importable from current Python; will rely on CMake to locate Torch (or project-local libtorch)."
fi

cmake .. \
    -DCMAKE_BUILD_TYPE=RelWithDebInfo \
    -DBUILD_SHARED_LIBS=ON \
    -Dno_module=true \
    -Dno_cuda=false \
    ${TORCH_DIR_ARG}

# Build the libraries
echo "Building libgeminifs and libnvm..."
make libgeminifs -j$(nproc)

# Verify libraries were built
if [ ! -f "lib/libgeminifs.so" ] && [ ! -f "lib/libgeminifs.a" ]; then
    echo "Error: libgeminifs library not found after build."
    exit 1
fi

if [ ! -f "lib/libnvm.so" ] && [ ! -f "lib/libnvm.a" ]; then
    echo "Error: libnvm library not found after build."
    exit 1
fi

echo "GeminiFS libraries built successfully:"
ls -la lib/

# Return to project root
cd ../../../

# Step 2: Build Python extension linking to precompiled GeminiFS
echo "Step 2: Building Python extension with precompiled GeminiFS..."

# Clean any previous builds
rm -rf build/
rm -rf infinikv.egg-info/
find . -name "*.so" -path "./infinikv/*" -delete

# Build the Python extension
"${PYTHON}" setup.py build_ext --inplace

# Verify the extension was built
if ! ls infinikv/c_ops*.so >/dev/null 2>&1; then
    echo "Error: Python extension not found after build."
    exit 1
fi

echo "Python extension built successfully:"
find . -name "c_ops*.so" -path "./infinikv/*"

# Step 3: Test the installation
echo "Step 3: Testing the installation..."
"${PYTHON}" -c "
try:
    import infinikv.c_ops as geminifs_ops
    print('✓ Successfully imported infinikv.c_ops')
    print('GeminiFS integration successful!')
except ImportError as e:
    print('✗ Failed to import infinikv.c_ops:', e)
    exit(1)
"

echo ""
echo "=== Build completed successfully! ==="
echo ""
echo "To use GeminiFS in your code:"
echo "1. Make sure the GeminiFS kernel module is loaded (if using real hardware)"
echo "2. Initialize GeminiFS with initialize_geminifs(config_path)"
echo "3. Use the functions in infinikv._custom_ops"
echo ""
echo "Libraries location: csrc/GeminiFS/build/lib/"
echo "Python extension: infinikv/c_ops*.so"